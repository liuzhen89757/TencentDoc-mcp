/** MCP 错误码与腾讯文档 ret 映射（需求文档 5.5 / 11.2） */

export type McpErrorCode =
  | "CONFIG_MISSING"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "API_ERROR"
  | "INVALID_ARGUMENT"
  | "INVALID_ENUM"
  | "CANDIDATE_NOT_FOUND"
  | "RECORD_NOT_FOUND"
  | "NO_WRITABLE_FIELDS"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export interface McpError {
  code: McpErrorCode;
  message: string;
  hint?: string;
}

/** 映射为协议级 isError=true 的错误码 */
const PROTOCOL_ERROR_CODES: ReadonlySet<McpErrorCode> = new Set([
  "CONFIG_MISSING",
  "AUTH_FAILED",
  "API_ERROR",
  "INTERNAL_ERROR",
]);

export function isProtocolError(code: McpErrorCode): boolean {
  return PROTOCOL_ERROR_CODES.has(code);
}

const AUTH_HINTS: Record<string, string> = {
  "10313": "请检查环境变量 ACCESS_TOKEN 是否已配置",
  "10302": "请检查环境变量 CLIENT_ID 是否正确",
  "10303": "请检查环境变量 OPEN_ID 是否正确",
  "37019": "请重新获取 Access-Token 并更新环境变量",
};

/**
 * 腾讯文档业务 ret → MCP 错误。
 * ret=0 不应调用此函数。
 */
export function classifyTencentRet(ret: number, msg: string): McpError {
  const code = String(ret);
  if (AUTH_HINTS[code]) {
    return {
      code: "AUTH_FAILED",
      message: msg || "腾讯文档鉴权失败",
      hint: AUTH_HINTS[code],
    };
  }
  return {
    code: "API_ERROR",
    message: msg || `腾讯文档返回错误 ret=${ret}`,
    hint: `ret=${ret}`,
  };
}

export function mcpError(
  code: McpErrorCode,
  message: string,
  hint?: string,
): McpError {
  return hint === undefined ? { code, message } : { code, message, hint };
}

/** 将 HTTP 状态映射为 MCP 错误 */
export function classifyHttpStatus(status: number, message: string): McpError {
  if (status === 429) {
    return mcpError("RATE_LIMITED", message, "触发腾讯文档频控，请稍后重试");
  }
  if (status === 401 || status === 403) {
    return mcpError("AUTH_FAILED", message, "请检查 Access-Token / Client-Id / Open-Id");
  }
  return mcpError("API_ERROR", message, `HTTP ${status}`);
}
