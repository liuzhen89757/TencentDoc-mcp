/** 工具模块契约：server.ts 按此注册到 MCP */
import type { ZodTypeAny } from "zod";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { TencentDocsClient } from "../tencent/client.js";
import type { ToolCallResult } from "../utils/result.js";

export interface ToolContext {
  config: AppConfig;
  client: TencentDocsClient;
  logger: Logger;
  /** 每次工具调用的请求 ID，用于日志串联 */
  requestId?: string;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolModule {
  name: string;
  title: string;
  description: string;
  /** MCP SDK registerTool 接受的 ZodRawShape */
  inputSchema: Record<string, ZodTypeAny>;
  annotations: ToolAnnotations;
  handler(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolCallResult>;
}

export type { ToolCallResult };
