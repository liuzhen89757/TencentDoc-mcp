/**
 * 工具三：add_interview_record 新增面试安排（需求文档 §9）。
 *
 * - 只写**面试安排表**（sheetID）；推荐表（recommendSheetID）只读，仅用于候选人存在性与姓名校验。
 * - 入参保留官方路径参数 fileID / sheetID 与官方请求体 addRecords；出参保留 ret / msg / data.addRecords。
 * - 业务扩展：confidence / dry_run / options（重复策略、待确认标记、孤儿记录策略）。
 * - values 只允许五个业务字段 + MCP 管理的待确认说明列；其他字段直接 INVALID_ARGUMENT。
 */
import { z } from "zod";
import type { AppConfig, FieldNames } from "../config.js";
import type { McpError } from "../tencent/errors.js";
import { classifyTencentRet, isProtocolError } from "../tencent/errors.js";
import type { TencentRecord, TencentValue } from "../tencent/types.js";
import {
  hoursBetween,
  isReasonableInterviewDate,
  isWithinWorkingHours,
  isWorkingDay,
  parseDateMs,
  sameShanghaiDay,
  toShanghaiDate,
} from "../utils/date.js";
import { normalizeStage } from "../utils/normalize.js";
import { buildPendingText } from "../utils/pending.js";
import { acquireKeyLocks } from "../utils/mutex.js";
import { credentialsError, errorResult, jsonResult } from "../utils/result.js";
import { hit, type RuleHit } from "../utils/rules.js";
import {
  extractSelect,
  extractText,
  isEmptyValue,
  selectValue,
  textValue,
} from "../utils/values.js";
import type { ToolCallResult, ToolModule } from "./types.js";

type DuplicatePolicy = "return_existing" | "create_anyway";

type WriteStatus =
  | "created"
  | "created_pending_confirmation"
  | "duplicate"
  | "dry_run"
  | "error";

interface McpState {
  status: WriteStatus;
  duplicate: boolean;
  confidence: number;
  threshold: number;
  pending: boolean;
  rules: RuleHit[];
  sanitized: boolean;
  warnings: string[];
}

/** 单条记录归一化后的中间结果 */
interface NormalizedRecord {
  candidateId: string;
  values: Record<string, TencentValue>;
  dateMs?: number;
  stage?: string;
  /** 仅本条记录命中的规则（不含全局 A07） */
  rules: RuleHit[];
  /** 命中重复约面时对应的已有记录 */
  duplicate?: TencentRecord;
}

interface OutputRecord {
  recordID: string;
  values: Record<string, TencentValue>;
}

const INVALID_ID_HINT = "请在工具入参中提供 fileID 和 sheetID";
const INVALID_FORMAT_HINT = "请检查工具入参格式";

const addInterviewRecordSchema = z.object({
  fileID: z.string().trim().min(1, "缺少 fileID"),
  sheetID: z.string().trim().min(1, "缺少 sheetID"),
  recommendSheetID: z.string().optional(),
  addRecords: z.object({
    records: z
      .array(
        z.object({
          values: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1, "addRecords.records 不能为空"),
  }),
  confidence: z
    .number({
      required_error: "缺少 confidence",
      invalid_type_error: "confidence 必须是 0–1 的数字",
    })
    .min(0, "confidence 必须在 0–1 之间")
    .max(1, "confidence 必须在 0–1 之间")
    .describe(
      "HR 视角的确认置信度（0–1），必填。表示本次新增无需 HR 人工确认的程度：" +
        "1=信息完整、可直接落库；越低越需要 HR 复核（例如候选人信息不完整）。" +
        "低于阈值时仍写入，但写「待确认说明」",
    ),
  dry_run: z.boolean().optional(),
  options: z
    .object({
      duplicate_policy: z.enum(["return_existing", "create_anyway"]).optional(),
      mark_pending: z.boolean().optional(),
      allow_orphan: z.boolean().optional(),
    })
    .optional(),
});

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function firstIssueMessage(error: z.ZodError): { message: string; hint: string } {
  const issue = error.issues[0];
  const field = issue?.path[0];
  if (field === "confidence") {
    return {
      message: issue?.message ?? "confidence 参数错误",
      hint: "confidence 为必填参数，取值为 0–1 的数字",
    };
  }
  const isIdField = field === "fileID" || field === "sheetID";
  return {
    message: issue?.message ?? "参数格式错误",
    hint: isIdField ? INVALID_ID_HINT : INVALID_FORMAT_HINT,
  };
}

/** 写工具统一 mcp 字段（不含 status/error） */
function mcpState(state: Omit<McpState, "status">): Omit<McpState, "status"> {
  return {
    duplicate: state.duplicate,
    confidence: state.confidence,
    threshold: state.threshold,
    pending: state.pending,
    rules: state.rules,
    sanitized: state.sanitized,
    warnings: state.warnings,
  };
}

function invalidArgument(message: string, hint: string): ToolCallResult {
  return errorResult({ ret: -1, code: "INVALID_ARGUMENT", message, hint });
}

/** 推荐表 / 安排表扫描失败：返回 error 响应，不写入 */
function scanFailureResult(
  failure: { ret: number; msg: string; transportError?: McpError },
  state: Omit<McpState, "status">,
): ToolCallResult {
  const mcp = mcpState(state);
  if (failure.transportError) {
    return errorResult(
      {
        ret: failure.ret,
        msg: failure.msg,
        code: failure.transportError.code,
        message: failure.transportError.message,
        ...(failure.transportError.hint !== undefined
          ? { hint: failure.transportError.hint }
          : {}),
        mcp,
      },
      isProtocolError(failure.transportError.code),
    );
  }
  const error = classifyTencentRet(failure.ret, failure.msg);
  return errorResult({
    ret: failure.ret,
    msg: failure.msg,
    code: error.code,
    message: error.message,
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    mcp,
  });
}

/** 从已有记录中读取归一化后的面试阶段 */
function existingStage(record: TencentRecord, config: AppConfig): string | undefined {
  const raw = record.values?.[config.fields.interviewStage];
  const extracted = extractSelect(raw);
  if (extracted === undefined) return undefined;
  const normalized = normalizeStage(
    extracted,
    config.stageAliases,
    config.interviewStages,
  );
  return normalized ?? extracted.trim();
}

/** 重复约面：同候选人 + 同阶段 +（同一天 或 相差 < 2 小时） */
function findDuplicate(
  existing: TencentRecord[],
  candidateId: string,
  dateMs: number,
  stage: string,
  config: AppConfig,
): TencentRecord | undefined {
  for (const record of existing) {
    const recordCandidateId = extractText(
      record.values?.[config.fields.candidateId],
    ).trim();
    if (recordCandidateId !== candidateId) continue;

    const recordStage = existingStage(record, config);
    if (recordStage === undefined || recordStage !== stage) continue;

    const recordDateMs = parseDateMs(record.values?.[config.fields.interviewDate]);
    if (recordDateMs === undefined) continue;

    if (sameShanghaiDay(recordDateMs, dateMs) || hoursBetween(recordDateMs, dateMs) < 2) {
      return record;
    }
  }
  return undefined;
}

/** A11：同一天该候选人已有其他轮次面试 */
function findOtherStageSameDay(
  existing: TencentRecord[],
  candidateId: string,
  dateMs: number,
  stage: string,
  config: AppConfig,
): TencentRecord | undefined {
  for (const record of existing) {
    const recordCandidateId = extractText(
      record.values?.[config.fields.candidateId],
    ).trim();
    if (recordCandidateId !== candidateId) continue;

    const recordStage = existingStage(record, config);
    if (recordStage === undefined || recordStage === stage) continue;

    const recordDateMs = parseDateMs(record.values?.[config.fields.interviewDate]);
    if (recordDateMs === undefined) continue;

    if (sameShanghaiDay(recordDateMs, dateMs)) return record;
  }
  return undefined;
}

interface NormalizeContext {
  fields: FieldNames;
  config: AppConfig;
  /** 有值时表示推荐表校验可用 */
  recommendMap?: Map<string, TencentRecord>;
  allowOrphan: boolean;
  warnings: string[];
}

/** 归一化单条记录；candidate_id 已在外层校验非空 */
function normalizeRecord(
  raw: Record<string, unknown>,
  ctx: NormalizeContext,
): NormalizedRecord {
  const { fields: f, config, recommendMap, allowOrphan, warnings } = ctx;
  const rules: RuleHit[] = [];
  const values: Record<string, TencentValue> = {};

  const candidateId = extractText(raw[f.candidateId] as TencentValue).trim();
  values[f.candidateId] = textValue(candidateId);

  // 姓名
  let name = extractText(raw[f.name] as TencentValue).trim();
  if (name === "") {
    rules.push(hit("A03", "hard", f.name, "姓名缺失，已移除该字段"));
  } else {
    values[f.name] = textValue(name);
  }

  // 面试日期：统一转换为毫秒时间戳字符串
  let dateMs: number | undefined;
  const rawDate = raw[f.interviewDate] as TencentValue;
  if (isEmptyValue(rawDate)) {
    rules.push(hit("A03", "hard", f.interviewDate, "面试日期缺失，已移除该字段"));
  } else {
    dateMs = parseDateMs(rawDate);
    if (dateMs === undefined) {
      rules.push(
        hit("A04", "hard", f.interviewDate, "面试日期无法解析为毫秒时间戳，已移除该字段"),
      );
    } else {
      values[f.interviewDate] = String(dateMs);
    }
  }

  // 面试阶段：单选值 + 别名归一化
  let stage: string | undefined;
  const rawStage = raw[f.interviewStage] as TencentValue;
  if (isEmptyValue(rawStage)) {
    rules.push(hit("A03", "hard", f.interviewStage, "面试阶段缺失，已移除该字段"));
  } else {
    const extracted = extractSelect(rawStage);
    const normalized =
      extracted === undefined
        ? undefined
        : normalizeStage(extracted, config.stageAliases, config.interviewStages);
    if (normalized === undefined) {
      rules.push(
        hit(
          "A05",
          "hard",
          f.interviewStage,
          "面试阶段无法归一化为允许的枚举，已移除该字段",
        ),
      );
    } else {
      stage = normalized;
      values[f.interviewStage] = selectValue(normalized);
    }
  }

  // 面试老师
  const interviewer = extractText(raw[f.interviewer] as TencentValue).trim();
  if (interviewer === "") {
    rules.push(hit("A03", "hard", f.interviewer, "面试老师缺失，已移除该字段"));
  } else {
    values[f.interviewer] = textValue(interviewer);
  }

  // 推荐表只读校验：存在性（A06）+ 姓名权威值（A08）
  if (recommendMap) {
    const recommend = recommendMap.get(candidateId);
    if (recommend === undefined) {
      rules.push(
        hit(
          "A06",
          "hard",
          f.candidateId,
          allowOrphan
            ? `推荐表中不存在候选人 ${candidateId}，已按 allow_orphan 策略继续写入`
            : `推荐表中不存在候选人 ${candidateId}`,
        ),
      );
    } else {
      const authoritativeName = extractText(recommend.values?.[f.name]).trim();
      if (authoritativeName === "") {
        warnings.push(`推荐表中候选人 ${candidateId} 的姓名为空，未覆盖入参姓名。`);
      } else {
        if (name !== "" && name !== authoritativeName) {
          rules.push(
            hit(
              "A08",
              "soft",
              f.name,
              `入参姓名「${name}」与推荐表姓名「${authoritativeName}」不一致，已以推荐表为准`,
            ),
          );
        } else if (name === "") {
          warnings.push(`入参姓名为空，已使用推荐表姓名「${authoritativeName}」。`);
        }
        name = authoritativeName;
        values[f.name] = textValue(authoritativeName);
      }
    }
  }

  return { candidateId, values, dateMs, stage, rules };
}

function toOutputRecord(rec: NormalizedRecord, policy: DuplicatePolicy): OutputRecord {
  if (rec.duplicate !== undefined && policy === "return_existing") {
    return { recordID: rec.duplicate.recordID, values: rec.duplicate.values };
  }
  return { recordID: "", values: rec.values };
}

export const addInterviewRecordTool: ToolModule = {
  name: "add_interview_record",
  title: "新增面试安排",
  description:
    "在腾讯文档智能表新增面试安排（对应官方 addRecords），只写 sheetID 指定的面试安排表，" +
    "不会写候选人推荐表。\n" +
    "fileID / sheetID 必填；recommendSheetID 可选（缺省读 RECOMMEND_SHEET_ID），推荐表只读，" +
    "仅用于候选人存在性与姓名校验：找到候选人时以其姓名为权威值覆盖姓名；找不到时按 options.allow_orphan" +
    "（默认 ALLOW_ORPHAN_ADD）决定写入并打标还是返回 CANDIDATE_NOT_FOUND；未提供推荐表 ID 时跳过校验并给出 warning。\n" +
    "addRecords.records[].values 只允许 candidate_id / 姓名 / 面试日期 / 面试阶段 / 面试老师 / 待确认说明：" +
    "其中 candidate_id 缺失或 values 出现其他字段会返回 INVALID_ARGUMENT 且不写入；姓名 / 面试日期 / " +
    "面试阶段 / 面试老师缺失或非法时移除该字段、仍新增其余字段并打待确认标记。面试日期统一转为毫秒时间戳字符串，" +
    "面试阶段按别名表归一化为单选值。\n" +
    "重复策略 options.duplicate_policy：默认 return_existing（同候选人 + 同阶段 + 同日或相差 < 2 小时不新增，" +
    "返回已有记录，mcp.status=\"duplicate\"）；create_anyway 时仍新增并打标。\n" +
    "dry_run=true 时只校验、不调用官方写入接口，mcp.status=\"dry_run\"，data.addRecords.records 返回将写入的记录" +
    "（新增项 recordID 为空字符串，重复项返回已有记录）。confidence 必填（0–1），表示本次新增无需 HR 人工确认的程度（1=信息完整、可直接落库，越低越需要 HR 复核）；缺失/非数字/越界返回错误且不写入；低于阈值仍写入并打标。",
  inputSchema: addInterviewRecordSchema.shape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  async handler(input, ctx): Promise<ToolCallResult> {
    const { config, client } = ctx;
    const fields = config.fields;

    // 1. 凭证缺失优先于一切（需求文档 11.2）
    const credentialError = credentialsError(config);
    if (credentialError) {
      return errorResult({
        ret: -1,
        code: credentialError.code,
        message: credentialError.message,
        ...(credentialError.hint !== undefined ? { hint: credentialError.hint } : {}),
      });
    }

    // 2. 入参校验（不调用官方接口）
    const parsed = addInterviewRecordSchema.safeParse(input);
    if (!parsed.success) {
      const { message, hint } = firstIssueMessage(parsed.error);
      return invalidArgument(message, hint);
    }
    const data = parsed.data;
    const rawRecords = data.addRecords.records;

    // 3. values 白名单（A02）
    const allowedKeys = new Set<string>([
      fields.candidateId,
      fields.name,
      fields.interviewDate,
      fields.interviewStage,
      fields.interviewer,
      fields.pending,
    ]);
    for (let index = 0; index < rawRecords.length; index += 1) {
      const values = rawRecords[index]?.values ?? {};
      for (const key of Object.keys(values)) {
        if (!allowedKeys.has(key)) {
          return invalidArgument(
            `第 ${index + 1} 条记录的 values 含不允许的字段「${key}」；只允许 ${[
              ...allowedKeys,
            ].join(" / ")}`,
            "请移除是否通过、面试评价等非新增字段；这些字段不属于新增面试安排的写入范围",
          );
        }
      }
    }

    // 4. candidate_id 非空（A01），并保留原值用于推荐表匹配
    const candidateIds: string[] = [];
    for (let index = 0; index < rawRecords.length; index += 1) {
      const values = rawRecords[index]?.values ?? {};
      const candidateId = extractText(values[fields.candidateId] as TencentValue).trim();
      if (candidateId === "") {
        return invalidArgument(
          `第 ${index + 1} 条记录缺少 candidate_id`,
          "candidate_id 是候选人关联与去重的依据，请补充后再新增面试安排",
        );
      }
      candidateIds.push(candidateId);
    }

    // 5. confidence / options / 当前时间（confidence 必填，缺失/非法已由 schema 拒绝）
    const threshold = config.confidenceThreshold;
    const confidence = data.confidence;

    const globalRules: RuleHit[] = [];
    if (confidence < threshold) {
      globalRules.push(
        hit(
          "A07",
          "soft",
          "confidence",
          `confidence=${confidence.toFixed(2)} 低于阈值 ${threshold.toFixed(2)}`,
        ),
      );
    }

    const policy: DuplicatePolicy =
      data.options?.duplicate_policy ?? "return_existing";
    const markPending = data.options?.mark_pending ?? config.markPending;
    const allowOrphan = data.options?.allow_orphan ?? config.allowOrphanAdd;
    const dryRun = data.dry_run === true;
    const nowMs = Date.now();
    const warnings: string[] = [];

    const baseState = (): Omit<McpState, "status"> => ({
      duplicate: false,
      confidence,
      threshold,
      pending: globalRules.length > 0,
      rules: [...globalRules],
      sanitized: false,
      warnings,
    });

    const recommendSheetID =
      trimOrUndefined(data.recommendSheetID) ?? trimOrUndefined(config.recommendSheetId);

    // 6. 推荐表只读校验（一次扫描，建立 candidate_id → record 映射）
    let recommendMap: Map<string, TencentRecord> | undefined;
    if (recommendSheetID === undefined) {
      if (!allowOrphan) {
        // 需求文档 6.2：缺少推荐表 ID 且不允许孤儿写入 → CONFIG_MISSING
        return errorResult({
          ret: -1,
          code: "CONFIG_MISSING",
          message:
            "缺少推荐表 ID（recommendSheetID / RECOMMEND_SHEET_ID），且 options.allow_orphan=false，无法校验候选人",
          hint: "请提供 recommendSheetID，或配置环境变量 RECOMMEND_SHEET_ID，或允许孤儿写入",
          mcp: mcpState(baseState()),
        });
      }
      warnings.push(
        "未提供 recommendSheetID 且未配置 RECOMMEND_SHEET_ID，已跳过推荐表候选人校验。",
      );
    } else {
      // 不传 fieldTitles：实测官方接口对中文列名过滤不可靠，
      // 推荐表校验需要 candidate_id/姓名，读取完整字段后再在本地提取。
      const recommendScan = await client.scanRecords(data.fileID, recommendSheetID, {
        maxRecords: config.maxScanRecords,
      });
      if (recommendScan.failure) {
        return scanFailureResult(recommendScan.failure, baseState());
      }
      recommendMap = new Map<string, TencentRecord>();
      for (const record of recommendScan.records) {
        const candidateId = extractText(
          record.values?.[fields.candidateId],
        ).trim();
        if (candidateId !== "" && !recommendMap.has(candidateId)) {
          recommendMap.set(candidateId, record);
        }
      }
      // A06 + allow_orphan=false：任一条找不到候选人都整体拒绝，不写入
      if (!allowOrphan) {
        for (let index = 0; index < candidateIds.length; index += 1) {
          const candidateId = candidateIds[index] ?? "";
          if (!recommendMap.has(candidateId)) {
            return errorResult({
              ret: -1,
              code: "CANDIDATE_NOT_FOUND",
              message: `推荐表中不存在候选人 ${candidateId}（第 ${index + 1} 条记录）`,
              hint: "请先在推荐表登记候选人，或设置 options.allow_orphan=true",
              mcp: mcpState(baseState()),
            });
          }
        }
      }
    }

    // 7. 逐条归一化 + 推荐表姓名校验
    const normalizeContext: NormalizeContext = {
      fields,
      config,
      ...(recommendMap !== undefined ? { recommendMap } : {}),
      allowOrphan,
      warnings,
    };
    const records = rawRecords.map((record) =>
      normalizeRecord(record.values, normalizeContext),
    );

    // 并发保护（需求 §12）：同一 candidate_id 的「重复检测 + 写入」串行执行，
    // 避免并发约面产生重复记录；不同候选人互不阻塞。
    const releaseLocks = await acquireKeyLocks(candidateIds);
    try {
    // 8. 扫描面试安排表做重复检测与 A11
    // 不传 fieldTitles：重复检测需要日期/阶段/姓名等中文列，读取完整字段更可靠。
    const interviewScan = await client.scanRecords(data.fileID, data.sheetID, {
      maxRecords: config.maxScanRecords,
    });
    if (interviewScan.failure) {
      return scanFailureResult(interviewScan.failure, baseState());
    }

    for (const record of records) {
      // A09 / A10：日期合理性（写 + 标记）
      if (record.dateMs !== undefined) {
        if (!isReasonableInterviewDate(record.dateMs, nowMs)) {
          record.rules.push(
            hit(
              "A09",
              "soft",
              fields.interviewDate,
              `面试日期 ${toShanghaiDate(record.dateMs)} 不在今天至 180 天内`,
            ),
          );
        }
        if (
          !isWorkingDay(record.dateMs, config.workingDays) ||
          !isWithinWorkingHours(record.dateMs, config.workingHours)
        ) {
          record.rules.push(
            hit(
              "A10",
              "soft",
              fields.interviewDate,
              "面试日期不在工作日或工作时间内",
            ),
          );
        }
      }

      // 重复检测
      if (record.dateMs !== undefined && record.stage !== undefined) {
        const duplicate = findDuplicate(
          interviewScan.records,
          record.candidateId,
          record.dateMs,
          record.stage,
          config,
        );
        if (duplicate !== undefined) {
          record.duplicate = duplicate;
          const dateText = toShanghaiDate(record.dateMs);
          if (policy === "return_existing") {
            warnings.push(`该候选人 ${dateText} 的${record.stage}已存在，未重复创建。`);
          } else {
            // 重复约面 create_anyway：继续新增，但打软规则标记
            record.rules.push(
              hit(
                "A12",
                "soft",
                undefined,
                "重复约面 create_anyway，已按策略继续新增",
              ),
            );
            warnings.push(
              `该候选人 ${dateText} 的${record.stage}已存在，按 create_anyway 策略仍新增。`,
            );
          }
        }

        // A11：同一天已有其他轮次
        const other = findOtherStageSameDay(
          interviewScan.records,
          record.candidateId,
          record.dateMs,
          record.stage,
          config,
        );
        if (other !== undefined) {
          record.rules.push(
            hit(
              "A11",
              "soft",
              fields.interviewStage,
              `该候选人 ${toShanghaiDate(record.dateMs)} 已有其他轮次面试`,
            ),
          );
        }
      }
    }

    // 9. pending 计算 + 写待确认说明（只对将要写入的记录）
    const allRules: RuleHit[] = [
      ...globalRules,
      ...records.flatMap((record) => record.rules),
    ];
    const pending = confidence < threshold || allRules.length > 0;

    for (const record of records) {
      const recordRules = [...globalRules, ...record.rules];
      const recordPending = recordRules.length > 0;
      if (recordPending && markPending) {
        record.values[fields.pending] = textValue(
          buildPendingText({
            confidence,
            threshold,
            rules: recordRules,
            nowMs,
            maxLength: config.pendingTextMaxLength,
          }),
        );
      }
      // 调用方传入的待确认说明一律丢弃（本工具从不复制入参 pending）
    }

    const anyDuplicate = records.some((record) => record.duplicate !== undefined);
    const allDuplicate =
      records.length > 0 && records.every((record) => record.duplicate !== undefined);
    const toWrite =
      policy === "return_existing"
        ? records.filter((record) => record.duplicate === undefined)
        : records;
    const sanitized = toWrite.length > 0;

    const stateBase: Omit<McpState, "status"> = {
      duplicate: anyDuplicate,
      confidence,
      threshold,
      pending,
      rules: allRules,
      sanitized,
      warnings,
    };

    // 10. dry_run：不调用官方写入接口
    if (dryRun) {
      return jsonResult({
        ret: 0,
        msg: "Succeed",
        data: {
          addRecords: {
            records: records.map((record) => toOutputRecord(record, policy)),
          },
        },
        mcp: { status: "dry_run" satisfies WriteStatus, ...mcpState(stateBase) },
      });
    }

    // 11. 全部重复：不调用官方接口，直接返回已有记录
    if (toWrite.length === 0) {
      const output = records.map((record) => {
        const duplicate = record.duplicate as TencentRecord;
        return { recordID: duplicate.recordID, values: duplicate.values };
      });
      const state: McpState = { status: "duplicate", ...stateBase };
      return jsonResult({
        ret: 0,
        msg: "Succeed",
        data: { addRecords: { records: output } },
        mcp: state,
      });
    }

    // 12. 正式调用官方 addRecords（只传非重复记录）
    const response = await client.addRecords(data.fileID, data.sheetID, {
      records: toWrite.map((record) => ({ values: record.values })),
    });

    if (response.transportError || response.ret !== 0) {
      const error =
        response.transportError ??
        classifyTencentRet(response.ret, response.msg);
      return errorResult(
        {
          ret: response.ret,
          msg: response.msg,
          code: error.code,
          message: error.message,
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
          mcp: mcpState(stateBase),
        },
        response.transportError !== undefined
          ? isProtocolError(error.code)
          : undefined,
      );
    }

    // 13. 成功：按输入顺序合并（重复项用已有记录，新增项依次取官方返回）
    const created = response.data?.addRecords?.records ?? [];
    let createdIndex = 0;
    const output: OutputRecord[] = records.map((record) => {
      if (record.duplicate !== undefined && policy === "return_existing") {
        return { recordID: record.duplicate.recordID, values: record.duplicate.values };
      }
      const official = created[createdIndex];
      createdIndex += 1;
      return official !== undefined
        ? { recordID: official.recordID, values: official.values }
        : { recordID: "", values: record.values };
    });

    const status: WriteStatus =
      policy === "return_existing" && allDuplicate
        ? "duplicate"
        : pending
          ? "created_pending_confirmation"
          : "created";

    return jsonResult({
      ret: response.ret,
      msg: response.msg,
      data: { addRecords: { records: output } },
      mcp: { status, ...mcpState(stateBase) },
    });
    } finally {
      releaseLocks();
    }
  },
};
