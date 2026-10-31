/** 工具返回值与统一错误结构（需求文档 11.1 / 11.2） */
import { missingCredentials, type AppConfig } from "../config.js";
import { isProtocolError, mcpError, type McpError, type McpErrorCode } from "../tencent/errors.js";

export interface ToolCallResult {
  /** 与 MCP SDK 的 TextContent 保持结构兼容（含索引签名） */
  content: Array<{ type: "text"; text: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** 把业务对象包装成 MCP 工具结果；text 便于机器人直接解析 JSON */
export function jsonResult(payload: unknown, isError = false): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

export interface ErrorResponseOptions {
  /** 默认 -1；官方业务错误时传官方 ret */
  ret?: number;
  msg?: string;
  code: McpErrorCode;
  message: string;
  hint?: string;
  /** 额外合并进 mcp 的字段（如 mode / confidence） */
  mcp?: Record<string, unknown>;
}

export function buildErrorResponse(options: ErrorResponseOptions): Record<string, unknown> {
  const { code, message, hint } = options;
  const error: McpError = hint === undefined ? { code, message } : { code, message, hint };
  return {
    ret: options.ret ?? -1,
    msg: options.msg ?? message,
    data: {},
    mcp: {
      status: "error",
      error,
      warnings: [],
      ...options.mcp,
    },
  };
}

export function errorResult(
  options: ErrorResponseOptions,
  isError?: boolean,
): ToolCallResult {
  return jsonResult(buildErrorResponse(options), isError ?? isProtocolError(options.code));
}

/** 凭证缺失检查；返回 null 表示凭证齐全 */
export function credentialsError(config: AppConfig): McpError | null {
  const missing = missingCredentials(config);
  if (missing.length === 0) return null;
  return mcpError(
    "CONFIG_MISSING",
    `缺少腾讯文档凭证：${missing.join("、")}`,
    "请在服务端环境变量中配置 ACCESS_TOKEN / CLIENT_ID / OPEN_ID",
  );
}

/** 把传输层错误转成统一错误响应 */
export function transportErrorResponse(
  error: McpError,
  ret: number,
  msg: string,
  extraMcp: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildErrorResponse({
    ret,
    msg,
    code: error.code,
    message: error.message,
    ...(error.hint ? { hint: error.hint } : {}),
    mcp: extraMcp,
  });
}
