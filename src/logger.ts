import pino, { type Logger } from "pino";

export type { Logger };

/**
 * 结构化 JSON 日志。
 * 隐私要求（需求文档 12）：面评正文不落日志，candidate_id 可脱敏。
 */
export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "accessToken",
        "clientId",
        "openId",
        "headers.access-token",
        "headers['access-token']",
        "headers.authorization",
        "*.feedback",
        "values.*",
        "feedback",
        "comment",
      ],
      censor: "[REDACTED]",
    },
  });
}

/** candidate_id 脱敏：保留前 2 位与后 2 位 */
export function maskId(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/** 面评只记录长度与简单哈希，不记录正文 */
export function textFingerprint(text: string): { length: number; hash: string } {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return { length: text.length, hash: (hash >>> 0).toString(16) };
}
