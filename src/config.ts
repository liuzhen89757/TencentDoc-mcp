/**
 * 配置加载：全部来自环境变量，缺失凭证时服务仍可启动，
 * 由具体工具调用返回 CONFIG_MISSING（见需求文档 6.1 / 11.2）。
 */
import { z } from "zod";

export interface FieldNames {
  /** 候选人 ID 列 */
  candidateId: string;
  /** 姓名 */
  name: string;
  /** 应聘岗位（推荐表摘要） */
  position: string;
  /** 推荐表面试阶段（公式列，只读） */
  recommendStage: string;
  /** 推荐表是否通过（公式列，只读） */
  recommendResult: string;
  /** 面试日期 */
  interviewDate: string;
  /** 面试阶段（安排表） */
  interviewStage: string;
  /** 面试老师 */
  interviewer: string;
  /** 面试评价 */
  feedback: string;
  /** 安排表是否通过 */
  interviewResult: string;
  /** 是否最新（公式列，只读） */
  isLatest: string;
  /** MCP 管理的待确认说明列 */
  pending: string;
}

export interface WorkingHours {
  /** 起始小时（含），Asia/Shanghai */
  start: number;
  /** 结束小时（不含），Asia/Shanghai */
  end: number;
}

export interface AppConfig {
  accessToken?: string;
  clientId?: string;
  openId?: string;
  recommendSheetId?: string;

  confidenceThreshold: number;
  maxScanRecords: number;
  /** options.max_records 的上限 */
  maxScanRecordsCap: number;
  pageSize: number;
  httpPort: number;
  mcpAuthToken?: string;
  allowOrphanAdd: boolean;
  markPending: boolean;
  logLevel: string;

  fields: FieldNames;

  /** 面试结果别名表，key 已归一化（小写、去空格） */
  resultAliases: Record<string, string>;
  /** 面试阶段别名表，key 已归一化 */
  stageAliases: Record<string, string>;
  /** 允许写入的面试阶段枚举；空数组表示不校验 */
  interviewStages: string[];

  workingHours: WorkingHours;
  /** ISO 星期：1=周一 … 7=周日 */
  workingDays: number[];

  apiBaseUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryDelaysMs: number[];
  rateLimit: {
    filePerMinute: number;
    openIdPerMinute: number;
  };

  /** 待确认说明文本最大长度 */
  pendingTextMaxLength: number;
}

const DEFAULT_RESULT_ALIASES: Record<string, string> = {
  通过: "通过",
  是: "通过",
  过: "通过",
  pass: "通过",
  passed: "通过",
  ok: "通过",
  同意录用: "通过",
  不通过: "不通过",
  否: "不通过",
  未通过: "不通过",
  淘汰: "不通过",
  拒绝: "不通过",
  fail: "不通过",
  failed: "不通过",
  待定: "待定",
  待确认: "待定",
  未知: "待定",
  待面试: "待定",
};

const DEFAULT_STAGE_ALIASES: Record<string, string> = {
  一面: "初试",
  初面: "初试",
  二面: "复试",
  复面: "复试",
  三面: "终试",
  终面: "终试",
  终试面: "终试",
  hr面: "HR面",
  hr面试: "HR面",
};

export const DEFAULT_INTERVIEW_STAGES = ["初试", "复试", "终试", "HR面"];

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function envNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = readEnv(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`环境变量 ${key} 必须是数字，当前值：${raw}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`环境变量 ${key} 不能小于 ${opts.min}，当前值：${value}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`环境变量 ${key} 不能大于 ${opts.max}，当前值：${value}`);
  }
  return value;
}

function envBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnv(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  throw new Error(`环境变量 ${key} 必须是布尔值（true/false），当前值：${raw}`);
}

function envCsv(env: NodeJS.ProcessEnv, key: string, fallback: string[]): string[] {
  const raw = readEnv(env, key);
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envJsonRecord(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: Record<string, string>,
): Record<string, string> {
  const raw = readEnv(env, key);
  if (raw === undefined) return { ...fallback };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`环境变量 ${key} 必须是 JSON 对象：${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`环境变量 ${key} 必须是 JSON 对象`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`环境变量 ${key} 的值必须是字符串：${k}`);
    }
    out[normalizeAliasKey(k)] = v;
  }
  return out;
}

/** 别名统一按小写、去除所有空白处理 */
export function normalizeAliasKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

/** 构建别名表：默认表 + 环境变量覆盖（key 归一化） */
function buildAliases(
  defaults: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    merged[normalizeAliasKey(k)] = v;
  }
  return merged;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<AppConfig>;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;

  const fields: FieldNames = {
    candidateId: readEnv(env, "FIELD_CANDIDATE_ID") ?? "candidate_id",
    name: readEnv(env, "FIELD_NAME") ?? "姓名",
    position: readEnv(env, "FIELD_POSITION") ?? "应聘岗位",
    recommendStage: readEnv(env, "FIELD_RECOMMEND_STAGE") ?? "面试阶段",
    recommendResult: readEnv(env, "FIELD_RECOMMEND_RESULT") ?? "是否通过",
    interviewDate: readEnv(env, "FIELD_INTERVIEW_DATE") ?? "面试日期",
    interviewStage: readEnv(env, "FIELD_INTERVIEW_STAGE") ?? "面试阶段",
    interviewer: readEnv(env, "FIELD_INTERVIEWER") ?? "面试老师",
    feedback: readEnv(env, "FIELD_FEEDBACK") ?? "面试评价",
    interviewResult: readEnv(env, "FIELD_INTERVIEW_RESULT") ?? "是否通过",
    isLatest: readEnv(env, "FIELD_IS_LATEST") ?? "是否最新",
    pending:
      readEnv(env, "PENDING_COLUMN") ?? readEnv(env, "FIELD_PENDING") ?? "待确认说明",
  };

  const pageSize = Math.min(envNumber(env, "PAGE_SIZE", 100, { min: 1 }), 100);
  const maxScanRecords = envNumber(env, "MAX_SCAN_RECORDS", 1000, { min: 1 });
  const workingHoursStart = envNumber(env, "WORKING_HOURS_START", 9, { min: 0, max: 24 });
  const workingHoursEnd = envNumber(env, "WORKING_HOURS_END", 20, { min: 0, max: 24 });

  const config: AppConfig = {
    accessToken: readEnv(env, "ACCESS_TOKEN"),
    clientId: readEnv(env, "CLIENT_ID"),
    openId: readEnv(env, "OPEN_ID"),
    recommendSheetId: readEnv(env, "RECOMMEND_SHEET_ID"),

    confidenceThreshold: envNumber(env, "CONFIDENCE_THRESHOLD", 0.8, { min: 0, max: 1 }),
    maxScanRecords,
    maxScanRecordsCap: envNumber(env, "MAX_SCAN_RECORDS_CAP", 5000, { min: 1 }),
    pageSize,
    httpPort: envNumber(env, "HTTP_PORT", 3000, { min: 1, max: 65535 }),
    mcpAuthToken: readEnv(env, "MCP_AUTH_TOKEN"),
    allowOrphanAdd: envBool(env, "ALLOW_ORPHAN_ADD", true),
    markPending: envBool(env, "MARK_PENDING", true),
    logLevel: readEnv(env, "LOG_LEVEL") ?? "info",

    fields,

    resultAliases: buildAliases(
      DEFAULT_RESULT_ALIASES,
      envJsonRecord(env, "RESULT_ALIASES", {}),
    ),
    stageAliases: buildAliases(
      DEFAULT_STAGE_ALIASES,
      envJsonRecord(env, "STAGE_ALIASES", {}),
    ),
    interviewStages: envCsv(env, "INTERVIEW_STAGES", DEFAULT_INTERVIEW_STAGES),

    workingHours: { start: workingHoursStart, end: workingHoursEnd },
    workingDays: envCsv(env, "WORKING_DAYS", ["1", "2", "3", "4", "5"]).map((d) => {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        throw new Error(`环境变量 WORKING_DAYS 只接受 1-7 的数字，当前值：${d}`);
      }
      return n;
    }),

    apiBaseUrl: readEnv(env, "TENCENT_DOCS_BASE_URL") ?? "https://docs.qq.com",
    requestTimeoutMs: envNumber(env, "REQUEST_TIMEOUT_MS", 10_000, { min: 1 }),
    maxRetries: envNumber(env, "MAX_RETRIES", 2, { min: 0, max: 5 }),
    retryDelaysMs: envCsv(env, "RETRY_DELAYS_MS", ["500", "1500"]).map((d) => {
      const n = Number(d);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`环境变量 RETRY_DELAYS_MS 必须是毫秒数，当前值：${d}`);
      }
      return n;
    }),
    rateLimit: {
      filePerMinute: envNumber(env, "RATE_LIMIT_FILE_PER_MINUTE", 120, { min: 1 }),
      openIdPerMinute: envNumber(env, "RATE_LIMIT_OPENID_PER_MINUTE", 250, { min: 1 }),
    },

    pendingTextMaxLength: envNumber(env, "PENDING_TEXT_MAX_LENGTH", 500, { min: 1 }),
  };

  return { ...config, ...options.overrides };
}

/** 三个凭证是否齐全 */
export function missingCredentials(config: AppConfig): string[] {
  const missing: string[] = [];
  if (!config.accessToken) missing.push("ACCESS_TOKEN");
  if (!config.clientId) missing.push("CLIENT_ID");
  if (!config.openId) missing.push("OPEN_ID");
  return missing;
}

/** 环境变量示例值，用于错误提示（不包含真实值） */
export const ENV_KEYS = z.enum([
  "ACCESS_TOKEN",
  "CLIENT_ID",
  "OPEN_ID",
  "RECOMMEND_SHEET_ID",
  "CONFIDENCE_THRESHOLD",
  "MAX_SCAN_RECORDS",
  "PAGE_SIZE",
  "HTTP_PORT",
  "MCP_AUTH_TOKEN",
  "ALLOW_ORPHAN_ADD",
  "PENDING_COLUMN",
  "MARK_PENDING",
  "LOG_LEVEL",
]);
