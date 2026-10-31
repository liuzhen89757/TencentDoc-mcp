/**
 * 工具二：update_interview_record 更新面试记录（需求文档 §8）。
 *
 * - 只写「面试安排表」；候选人推荐表全程只读，本工具不访问推荐表。
 * - values 只允许「是否通过」「面试评价」两个业务字段；「待确认说明」由 MCP 管理。
 * - 置信度只影响是否打待确认标记，不影响是否写入（需求 §10）。
 * - hard 规则失败的字段会被移除并打标，其余可写字段仍然写入。
 * - dry_run=true 时只校验、不落库，返回将写入的 values。
 */
import { z } from "zod";
import { classifyTencentRet, isProtocolError } from "../tencent/errors.js";
import type { TencentValue, UpdateRecordEntry } from "../tencent/types.js";
import { normalizeResult } from "../utils/normalize.js";
import { buildPendingText } from "../utils/pending.js";
import {
  credentialsError,
  errorResult,
  jsonResult,
  transportErrorResponse,
  type ToolCallResult,
} from "../utils/result.js";
import { hit, type RuleHit } from "../utils/rules.js";
import {
  emptyValue,
  extractSelect,
  extractText,
  selectValue,
  textValue,
} from "../utils/values.js";
import type { ToolModule } from "./types.js";

/** 面评最小长度（trim 后按字符数） */
const FEEDBACK_MIN_LENGTH = 10;
/** 面评最大长度，超出截断 */
const FEEDBACK_MAX_LENGTH = 5000;

const inputObjectSchema = z.object({
  fileID: z.string().describe("文档 ID，必填"),
  sheetID: z.string().describe("面试安排表（子表）ID，必填"),
  updateRecords: z
    .object({
      records: z
        .array(
          z.object({
            recordID: z.string().describe("记录 ID，必填；从 query_records 获取"),
            values: z.record(z.unknown()).describe("字段值，key 为字段标题，value 为官方格式"),
          }),
        )
        .describe("要更新的记录，至少一条"),
    })
    .describe("官方 UpdateRecordsRequest"),
  confidence: z
    .number({
      required_error: "缺少 confidence",
      invalid_type_error: "confidence 必须是 0–1 的数字",
    })
    .min(0, "confidence 必须在 0–1 之间")
    .max(1, "confidence 必须在 0–1 之间")
    .describe(
      "HR 视角的确认置信度（0–1），必填。表示本次记录变动无需 HR 人工确认的程度：" +
        "1=信息完整、可直接落库；越低越需要 HR 复核（例如表中缺少面试日期却要更新面评）。" +
        "低于阈值时仍写入，但写「待确认说明」；只影响标记，不影响是否写入",
    ),
  dry_run: z.boolean().optional().describe("只校验、不写入；返回将写入的 values"),
  options: z
    .object({
      mark_pending: z
        .boolean()
        .optional()
        .describe("是否写入/清空待确认说明；缺省取服务端 MARK_PENDING（默认 true）"),
    })
    .optional(),
});

/** S02：否定词（结果=通过时不应出现） */
const NEGATIVE_FEEDBACK_KEYWORDS = [
  "不通过",
  "未通过",
  "淘汰",
  "拒绝",
  "不合适",
  "不匹配",
  "不符合",
  "不建议",
  "不推荐",
  "未达到",
  "fail",
  "reject",
];

/** S02：肯定词（结果=不通过时不应出现） */
const POSITIVE_FEEDBACK_KEYWORDS = [
  "通过",
  "录取",
  "录用",
  "建议进入",
  "推荐",
  "优秀",
  "满意",
  "合适",
  "匹配",
  "pass",
];

/** 判断「不通过」结果时，先从面评中剔除否定短语，避免把「不通过」里的「通过」误判为肯定 */
const NEGATED_POSITIVE_PHRASES = /不通过|未通过|不建议|不推荐|不合适|不匹配|不符合|未达到/g;

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "参数校验失败";
  if (issue.path[0] === "confidence") return issue.message;
  const path = issue.path.join(".");
  return path ? `参数校验失败：${path} ${issue.message}` : `参数校验失败：${issue.message}`;
}

function invalidArgument(
  message: string,
  hint = "请检查工具入参：fileID/sheetID 必填，values 只允许面试结果与面试评价",
): ToolCallResult {
  return errorResult({ code: "INVALID_ARGUMENT", message, hint }, false);
}

/**
 * S02：结果与面评语义冲突的简单关键词判断。
 * - 结果=通过：面评出现否定词 → 冲突；
 * - 结果=不通过：先剔除「不通过/未通过/不建议…」等否定短语，再出现肯定词 → 冲突；
 * - 结果=待定：不触发。
 * 仅做关键词匹配，可能误报/漏报，因此是 soft 规则（只打标，不拦截写入）。
 *
 * S03（面评中出现其他候选人姓名）本期不实现：需要额外读取推荐表候选人名单，
 * 而本工具按需求不访问推荐表；且姓名关键词误报率高，故不实现。
 */
function hasFeedbackConflict(result: string, feedback: string): boolean {
  const text = feedback.toLowerCase();
  if (result === "通过") {
    return NEGATIVE_FEEDBACK_KEYWORDS.some((keyword) => text.includes(keyword));
  }
  if (result === "不通过") {
    const positiveText = text.replace(NEGATED_POSITIVE_PHRASES, " ");
    return POSITIVE_FEEDBACK_KEYWORDS.some((keyword) => positiveText.includes(keyword));
  }
  return false;
}

export const updateInterviewRecordTool: ToolModule = {
  name: "update_interview_record",
  title: "更新面试记录",
  description: [
    "更新腾讯文档「面试安排表」中的面试记录，只写面试安排表，不写候选人推荐表。",
    "values 只允许两个业务字段：是否通过、面试评价（待确认说明由 MCP 管理，调用方传值会被覆盖）；其他字段会被拒绝。",
    "是否通过会按别名表归一化（如「过」→「通过」）；面试评价须为 10–5000 字，过短会移除、过长会截断并打待确认标记。",
    "confidence 必填，取值 0–1，表示本次记录变动无需 HR 人工确认的程度：1=信息完整、可直接落库，越低越需要 HR 复核（例如表中缺少面试日期却要更新面评）。缺失/非数字/越界返回错误且不写入；它只影响是否写「待确认说明」，不影响是否写入。",
    "dry_run=true 时只校验并返回将写入的 values，不调用腾讯文档接口。",
  ].join("\n"),
  inputSchema: inputObjectSchema.shape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  async handler(input, ctx): Promise<ToolCallResult> {
    const { config } = ctx;

    // 1. 凭证校验（CONFIG_MISSING）
    const credError = credentialsError(config);
    if (credError) {
      return errorResult({
        code: credError.code,
        message: credError.message,
        hint: credError.hint,
      });
    }

    // 2. 参数结构校验
    const parsed = inputObjectSchema.safeParse(input);
    if (!parsed.success) {
      const hint =
        parsed.error.issues[0]?.path[0] === "confidence"
          ? "confidence 为必填参数，取值为 0–1 的数字"
          : undefined;
      return invalidArgument(formatZodError(parsed.error), hint);
    }

    const fileID = parsed.data.fileID.trim();
    const sheetID = parsed.data.sheetID.trim();
    if (!fileID) {
      return invalidArgument("缺少 fileID", "请在工具入参中提供 fileID 和 sheetID");
    }
    if (!sheetID) {
      return invalidArgument("缺少 sheetID", "请在工具入参中提供 fileID 和 sheetID");
    }

    const records = parsed.data.updateRecords.records;
    if (records.length === 0) {
      return invalidArgument("updateRecords.records 不能为空");
    }
    for (const record of records) {
      if (record.recordID.trim() === "") {
        return invalidArgument("updateRecords.records[].recordID 不能为空");
      }
    }

    const resultField = config.fields.interviewResult;
    const feedbackField = config.fields.feedback;
    const pendingField = config.fields.pending;
    const allowedFields = [resultField, feedbackField, pendingField];
    const allowedFieldSet = new Set(allowedFields);

    // H02 + 「是否通过 / 面试评价 至少提供一个」：任何一条不满足都整体拒绝，不写入
    for (const record of records) {
      for (const key of Object.keys(record.values)) {
        if (key.trim() === "" || !allowedFieldSet.has(key)) {
          return invalidArgument(
            `values 包含不允许的字段：${key === "" ? "(空字段名)" : key}；只允许 ${allowedFields.join("、")}`,
          );
        }
      }
      const hasResult = hasOwn(record.values, resultField);
      const hasFeedback = hasOwn(record.values, feedbackField);
      if (!hasResult && !hasFeedback) {
        return invalidArgument(
          `recordID=${record.recordID} 的 values 至少需要提供 ${resultField} 或 ${feedbackField} 之一`,
        );
      }
    }

    // 3. 置信度与全局规则（confidence 必填，缺失/非数字/越界已由 schema 拒绝）
    const rules: RuleHit[] = [];
    const confidence = parsed.data.confidence;
    const threshold = config.confidenceThreshold;
    if (confidence < threshold) {
      rules.push(
        hit(
          "S01",
          "soft",
          undefined,
          `confidence=${confidence.toFixed(2)} 低于阈值 ${threshold.toFixed(2)}`,
        ),
      );
    }

    const markPending = parsed.data.options?.mark_pending ?? config.markPending;

    // 4. 逐条归一化（每条记录独立校验、独立移除非法字段）
    let sanitized = false;
    const normalizedRecords: Array<{ recordID: string; values: Record<string, TencentValue> }> = [];

    for (const record of records) {
      const recordID = record.recordID;
      const rawValues = record.values;
      const values: Record<string, TencentValue> = {};
      let recordSanitized = false;

      // 调用方传入的待确认说明一律由 MCP 管理：pending 时重写、正常时清空、mark_pending=false 时丢弃
      if (hasOwn(rawValues, pendingField)) {
        recordSanitized = true;
      }

      // 4a. 是否通过：extractSelect → normalizeResult；无法归一化则移除 + H04
      let normalizedResult: string | undefined;
      if (hasOwn(rawValues, resultField)) {
        const rawResult = extractSelect(rawValues[resultField] as TencentValue);
        normalizedResult = normalizeResult(rawResult, config.resultAliases);
        if (normalizedResult === undefined) {
          rules.push(
            hit(
              "H04",
              "hard",
              resultField,
              `记录 ${recordID}：${resultField}「${rawResult ?? ""}」无法归一化，已移除该字段`,
            ),
          );
          recordSanitized = true;
        } else {
          // 以官方单选格式写入归一化后的值
          values[resultField] = selectValue(normalizedResult);
          if ((rawResult ?? "").trim() !== normalizedResult) {
            recordSanitized = true;
          }
        }
      }

      // 4b. 面试评价：多段文本合并；空/过短移除 + H05；过长截断 + H05
      let feedbackText: string | undefined;
      if (hasOwn(rawValues, feedbackField)) {
        const rawFeedback = rawValues[feedbackField];
        const merged = extractText(rawFeedback as TencentValue);
        const trimmed = merged.trim();
        if (trimmed.length < FEEDBACK_MIN_LENGTH) {
          rules.push(
            hit(
              "H05",
              "hard",
              feedbackField,
              `记录 ${recordID}：${feedbackField} 为空或少于 ${FEEDBACK_MIN_LENGTH} 字（当前 ${trimmed.length} 字），已移除该字段`,
            ),
          );
          recordSanitized = true;
        } else if (trimmed.length > FEEDBACK_MAX_LENGTH) {
          feedbackText = trimmed.slice(0, FEEDBACK_MAX_LENGTH);
          values[feedbackField] = textValue(feedbackText);
          rules.push(
            hit(
              "H05",
              "hard",
              feedbackField,
              `记录 ${recordID}：${feedbackField} 超过 ${FEEDBACK_MAX_LENGTH} 字，已截断到 ${FEEDBACK_MAX_LENGTH} 字`,
            ),
          );
          recordSanitized = true;
        } else {
          feedbackText = trimmed;
          // 多段文本合并为单段官方文本值
          values[feedbackField] = textValue(trimmed);
          if (merged !== trimmed) {
            recordSanitized = true;
          }
          if (Array.isArray(rawFeedback) && rawFeedback.length > 1) {
            recordSanitized = true;
          }
        }
      }

      // 4c. S02：结果与面评语义冲突（仅当两者都成功归一化时判断）
      if (
        normalizedResult !== undefined &&
        feedbackText !== undefined &&
        hasFeedbackConflict(normalizedResult, feedbackText)
      ) {
        rules.push(
          hit(
            "S02",
            "soft",
            feedbackField,
            `记录 ${recordID}：${resultField}「${normalizedResult}」与 ${feedbackField} 语义可能冲突`,
          ),
        );
      }

      if (recordSanitized) sanitized = true;
      normalizedRecords.push({ recordID, values });
    }

    // 5. pending = confidence < 阈值 或 任一规则命中
    const pending = confidence < threshold || rules.length > 0;

    // 6. 去除待确认说明后没有可写字段 → 整个调用拒绝，不调用官方接口
    for (const record of normalizedRecords) {
      if (Object.keys(record.values).length === 0) {
        return errorResult({
          code: "NO_WRITABLE_FIELDS",
          message: `recordID=${record.recordID} 的 ${resultField} 与 ${feedbackField} 均不可写入，没有可写字段`,
          hint: "请补充有效的面试结果或面试评价后重试",
          mcp: { confidence, threshold, pending, rules, sanitized, warnings: [] },
        });
      }
    }

    const warnings: string[] = [];
    if (pending && !markPending) {
      warnings.push("存在待确认项（低置信度或规则命中），但 options.mark_pending=false，未写入待确认说明。");
    }

    // 7. 写/清空待确认说明（mark_pending=false 时不碰该字段）
    const pendingText =
      markPending && pending
        ? buildPendingText({
            confidence,
            threshold,
            rules,
            maxLength: config.pendingTextMaxLength,
          })
        : undefined;

    const prepared: UpdateRecordEntry[] = normalizedRecords.map((record) => {
      const values: Record<string, TencentValue> = { ...record.values };
      if (markPending) {
        values[pendingField] =
          pending && pendingText !== undefined ? textValue(pendingText) : emptyValue();
        // 写入或清空待确认说明都视为 values 被修改
        sanitized = true;
      }
      return { recordID: record.recordID, values };
    });

    const mcpBase = { confidence, threshold, pending, rules, sanitized, warnings };

    // 8. dry_run：不调用官方接口
    if (parsed.data.dry_run === true) {
      return jsonResult({
        ret: 0,
        msg: "Succeed",
        data: { updateRecords: { records: prepared } },
        mcp: { status: "dry_run", ...mcpBase },
      });
    }

    // 9. 调用官方 updateRecords
    const response = await ctx.client.updateRecords(fileID, sheetID, { records: prepared });

    if (response.transportError) {
      return jsonResult(
        transportErrorResponse(response.transportError, response.ret, response.msg, mcpBase),
        isProtocolError(response.transportError.code),
      );
    }

    if (response.ret !== 0) {
      const error = classifyTencentRet(response.ret, response.msg);
      return errorResult({
        ret: response.ret,
        msg: response.msg,
        code: error.code,
        message: error.message,
        hint: error.hint,
        mcp: mcpBase,
      });
    }

    return jsonResult({
      ret: 0,
      msg: response.msg || "Succeed",
      data: response.data,
      mcp: {
        status: pending ? "updated_pending_confirmation" : "updated",
        ...mcpBase,
      },
    });
  },
};

export default updateInterviewRecordTool;
