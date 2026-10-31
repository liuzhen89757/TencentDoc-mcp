/**
 * 工具一：query_records 查询记录（需求文档 7）。
 *
 * - 不传 candidate_id：官方 getRecords 直通（mcp.mode = "recommend"），一次请求、原样透传。
 * - 传 candidate_id：内部翻页全表扫描 sheetID 指定表，过滤 + 去重（mcp.mode = "interview"）。
 */
import { z } from "zod";
import type { ScanOptions } from "../tencent/client.js";
import { classifyTencentRet, isProtocolError } from "../tencent/errors.js";
import type { GetRecordsData, GetRecordsRequest } from "../tencent/types.js";
import { filterByCandidate, pickPrimaryRecord, sortRecordIdsByDateDesc } from "../utils/dedup.js";
import {
  buildErrorResponse,
  credentialsError,
  jsonResult,
  transportErrorResponse,
  type ErrorResponseOptions,
} from "../utils/result.js";
import type { ToolCallResult, ToolModule } from "./types.js";

const EMPTY_WARNING = "该候选人在面试安排表中暂无记录，可调用 add_interview_record 约面。";

const sortSchema = z.object({
  fieldTitle: z.string(),
  desc: z.boolean().optional(),
});

const getRecordsSchema = z.object({
  viewID: z.string().optional(),
  recordIDs: z.array(z.string()).optional(),
  fieldTitles: z.array(z.string()).optional(),
  sort: z.array(sortSchema).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
});

const queryRecordsSchema = z.object({
  fileID: z
    .string({ required_error: "缺少 fileID", invalid_type_error: "fileID 必须是字符串" })
    .trim()
    .min(1, "缺少 fileID"),
  sheetID: z
    .string({ required_error: "缺少 sheetID", invalid_type_error: "sheetID 必须是字符串" })
    .trim()
    .min(1, "缺少 sheetID"),
  getRecords: getRecordsSchema.optional(),
  candidate_id: z.string().optional(),
  options: z
    .object({
      max_records: z.number().int().min(1).max(5000).optional(),
    })
    .optional(),
});

type GetRecordsInput = z.infer<typeof getRecordsSchema>;

const INVALID_ID_HINT = "请在工具入参中提供 fileID 和 sheetID";
const INVALID_FORMAT_HINT = "请检查工具入参格式";

function errorOutput(options: ErrorResponseOptions): ToolCallResult {
  return jsonResult(buildErrorResponse(options), isProtocolError(options.code));
}

function invalidArgument(message: string, hint: string): ToolCallResult {
  return errorOutput({ ret: -1, code: "INVALID_ARGUMENT", message, hint });
}

/** 只传递调用方实际提供的官方字段，避免把 undefined 发给官方接口 */
function toOfficialRequest(input: GetRecordsInput): GetRecordsRequest {
  const request: GetRecordsRequest = {};
  if (input.viewID !== undefined) request.viewID = input.viewID;
  if (input.recordIDs !== undefined) request.recordIDs = input.recordIDs;
  if (input.fieldTitles !== undefined) request.fieldTitles = input.fieldTitles;
  if (input.sort !== undefined) {
    request.sort = input.sort.map((item) =>
      item.desc === undefined
        ? { fieldTitle: item.fieldTitle }
        : { fieldTitle: item.fieldTitle, desc: item.desc },
    );
  }
  if (input.offset !== undefined) request.offset = input.offset;
  if (input.limit !== undefined) request.limit = input.limit;
  return request;
}

const EMPTY_GET_RECORDS: GetRecordsData = {
  hasMore: false,
  next: 0,
  total: 0,
  records: [],
};

export const queryRecordsTool: ToolModule = {
  name: "query_records",
  title: "查询智能表记录",
  description:
    "查询腾讯文档智能表记录（对应官方 getRecords）。fileID / sheetID 必填，且只查询 sheetID 指定的那一张子表；" +
    "MCP 不推断表角色，也不会跨表查询。\n" +
    "模式 A（不传 candidate_id）：官方直通，只调用一次官方接口，原样透传 getRecords 中的 viewID / recordIDs / " +
    "fieldTitles / sort / offset / limit，返回官方 ret / msg / data.getRecords，mcp.mode=\"recommend\"；" +
    "此模式完全不做去重，offset / limit 按官方语义生效。\n" +
    "模式 B（传 candidate_id）：在 sheetID 指定的表内做内部翻页全表扫描，" +
    "按 candidate_id 过滤后去重，主记录按「是否最新=是 → 面试日期最大 → createTime 最大」选取，并在 " +
    "mcp.dedup.allRecordIDs 返回该候选人的全部记录 ID；mcp.mode=\"interview\"。\n" +
    "重要：只有传 candidate_id（模式 B）才会去重；该模式下调用方传入的 getRecords.fieldTitles / " +
    "getRecords.offset / getRecords.limit 不用于官方查询——fieldTitles 与 offset 被忽略、limit 仅作为" +
    "内部页大小参考（最大 100），结果始终是完整扫描后去重。" +
    "（实测腾讯文档接口对中文列名的 fieldTitles 过滤不可靠，模式 B 为保证去重正确会读取完整字段。）\n" +
    "options.max_records 仅在模式 B 生效，默认取环境变量 MAX_SCAN_RECORDS（默认 1000），上限 5000（MAX_SCAN_RECORDS_CAP）。",
  inputSchema: queryRecordsSchema.shape,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  async handler(input, ctx): Promise<ToolCallResult> {
    // 1. 凭证缺失优先于一切（需求文档 7.7 / 11.2）
    const credentialError = credentialsError(ctx.config);
    if (credentialError) {
      return errorOutput({
        ret: -1,
        code: credentialError.code,
        message: credentialError.message,
        ...(credentialError.hint !== undefined ? { hint: credentialError.hint } : {}),
      });
    }

    // 2. 入参校验（不调用官方接口）
    const parsed = queryRecordsSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      const isIdField = field === "fileID" || field === "sheetID";
      return invalidArgument(
        issue?.message ?? "参数格式错误",
        isIdField ? INVALID_ID_HINT : INVALID_FORMAT_HINT,
      );
    }

    const { fileID, sheetID, getRecords } = parsed.data;
    const officialInput = getRecords ?? {};
    const candidateId = parsed.data.candidate_id?.trim();

    // 3. 模式 B：candidate_id 过滤 + 去重
    if (candidateId) {
      const limit = officialInput.limit;
      const pageSize = Math.min(Math.max(limit ?? 100, 1), 100);
      const requestedMax =
        parsed.data.options?.max_records ?? ctx.config.maxScanRecords;
      const maxRecords = Math.min(requestedMax, ctx.config.maxScanRecordsCap);

      // 实测官方接口对中文列名的 fieldTitles 过滤不可靠（可能只返回部分列），
      // 模式 B 为保证去重所需字段完整，内部扫描一律不传 fieldTitles。
      const scanWarnings: string[] = [];
      if (officialInput.fieldTitles !== undefined) {
        scanWarnings.push(
          "模式 B 会忽略 getRecords.fieldTitles（该接口对中文列名过滤不可靠），已读取完整字段。",
        );
      }

      const scanOptions: ScanOptions = {
        maxRecords,
        pageSize,
      };
      if (officialInput.recordIDs !== undefined) {
        scanOptions.recordIDs = officialInput.recordIDs;
      }

      const scan = await ctx.client.scanRecords(fileID, sheetID, scanOptions);

      const scanMcp = {
        mode: "interview" as const,
        candidate_id: candidateId,
        scanned: scan.scanned,
        truncated: scan.truncated,
        warnings: scanWarnings,
      };

      if (scan.failure) {
        if (scan.failure.transportError) {
          return jsonResult(
            transportErrorResponse(
              scan.failure.transportError,
              scan.failure.ret,
              scan.failure.msg,
              scanMcp,
            ),
            isProtocolError(scan.failure.transportError.code),
          );
        }
        const error = classifyTencentRet(scan.failure.ret, scan.failure.msg);
        return errorOutput({
          ret: scan.failure.ret,
          msg: scan.failure.msg,
          code: error.code,
          message: error.message,
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
          mcp: scanMcp,
        });
      }

      const matched = filterByCandidate(
        scan.records,
        candidateId,
        ctx.config.fields.candidateId,
      );
      const primary = pickPrimaryRecord(
        matched,
        ctx.config.fields.interviewDate,
        ctx.config.fields.isLatest,
      );
      const allRecordIDs = sortRecordIdsByDateDesc(
        matched,
        ctx.config.fields.interviewDate,
      );
      const records = primary ? [primary] : [];
      const warnings: string[] = [...scanWarnings];
      if (matched.length === 0) warnings.push(EMPTY_WARNING);

      return jsonResult({
        ret: 0,
        msg: "Succeed",
        data: {
          getRecords: {
            hasMore: false,
            next: 0,
            total: records.length,
            records,
          },
        },
        mcp: {
          mode: "interview",
          candidate_id: candidateId,
          dedup: {
            applied: true,
            primaryRecordID: primary?.recordID ?? "",
            allRecordIDs,
            duplicateCount: matched.length,
          },
          scanned: scan.scanned,
          truncated: scan.truncated,
          warnings,
        },
      });
    }

    // 4. 模式 A：官方直通
    const response = await ctx.client.getRecords(
      fileID,
      sheetID,
      toOfficialRequest(officialInput),
    );

    if (response.transportError) {
      return jsonResult(
        transportErrorResponse(
          response.transportError,
          response.ret,
          response.msg,
          { mode: "recommend", warnings: [] },
        ),
        isProtocolError(response.transportError.code),
      );
    }

    if (response.ret !== 0) {
      const error = classifyTencentRet(response.ret, response.msg);
      return errorOutput({
        ret: response.ret,
        msg: response.msg,
        code: error.code,
        message: error.message,
        ...(error.hint !== undefined ? { hint: error.hint } : {}),
        mcp: { mode: "recommend", warnings: [] },
      });
    }

    const getRecordsData = response.data?.getRecords ?? EMPTY_GET_RECORDS;
    const records = getRecordsData.records ?? [];

    return jsonResult({
      ret: response.ret,
      msg: response.msg,
      data: { getRecords: getRecordsData },
      mcp: {
        mode: "recommend",
        scanned: records.length,
        truncated: false,
        warnings: [],
      },
    });
  },
};
