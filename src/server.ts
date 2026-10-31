/**
 * MCP Server 与 HTTP 接入层。
 *
 * - Streamable HTTP 无状态模式：每个 POST /mcp 请求新建 McpServer + Transport，
 *   便于重启与水平扩展（需求文档 4.2）。
 * - Bearer Token 保护 /mcp（配置 MCP_AUTH_TOKEN 时生效）。
 * - GET /healthz 供容器健康检查。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { TencentDocsClient } from "./tencent/client.js";
import { TOOL_MODULES } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";
import type { ToolCallResult } from "./utils/result.js";

export const SERVER_NAME = "tencent-doc-smartbook";
export const SERVER_VERSION = "0.1.0";

export interface ServerDeps {
  config: AppConfig;
  client: TencentDocsClient;
  logger: Logger;
}

/** JSON-RPC 错误响应体 */
export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
  };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcErrorBody {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 工具执行出现未预期异常时的统一返回（不向客户端暴露堆栈） */
function internalErrorResult(requestId: string): ToolCallResult {
  const payload = {
    ret: -1,
    msg: "工具调用失败",
    data: {},
    mcp: {
      status: "error",
      error: {
        code: "INTERNAL_ERROR",
        message: "工具调用失败，请查看服务端日志",
        hint: "请稍后重试或联系管理员",
      },
      warnings: [],
      request_id: requestId,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

/** 把内部结果收敛为 SDK 的 CallToolResult（SDK 类型含字符串索引签名） */
function toCallToolResult(result: ToolCallResult): CallToolResult {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

/**
 * 构建 McpServer 并注册全部工具。
 * 每个工具调用生成 requestId，记录工具名、耗时与成功/失败。
 */
export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  for (const mod of TOOL_MODULES) {
    server.registerTool(
      mod.name,
      {
        title: mod.title,
        description: mod.description,
        inputSchema: mod.inputSchema,
        annotations: mod.annotations,
      },
      async (input: Record<string, unknown>): Promise<CallToolResult> => {
        const requestId = randomUUID();
        const startedAt = Date.now();
        deps.logger.info(
          { requestId, tool: mod.name },
          "mcp_tool_call_start",
        );

        try {
          const ctx: ToolContext = {
            config: deps.config,
            client: deps.client,
            logger: deps.logger,
            requestId,
          };
          const result = await mod.handler(input, ctx);
          deps.logger.info(
            {
              requestId,
              tool: mod.name,
              durationMs: Date.now() - startedAt,
              isError: result.isError === true,
            },
            "mcp_tool_call_end",
          );
          return toCallToolResult(result);
        } catch (err) {
          deps.logger.error(
            {
              requestId,
              tool: mod.name,
              durationMs: Date.now() - startedAt,
              err: err instanceof Error ? err.message : String(err),
            },
            "mcp_tool_call_failed",
          );
          return toCallToolResult(internalErrorResult(requestId));
        }
      },
    );
  }

  return server;
}

/** 常量时间比较，避免通过响应时间推断 Token */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** 从 Authorization 头解析 Bearer Token（scheme 不区分大小写） */
function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/**
 * 取请求携带的 Token：
 * 1. 优先 Authorization: Bearer <token>
 * 2. 兼容不支持自定义请求头的机器人：?token=<token> 或 ?access_token=<token>
 *
 * 查询参数中的 Token 可能出现在访问日志/浏览器历史里，生产环境优先用请求头。
 */
function extractProvidedToken(req: Request): string | undefined {
  const bearer = extractBearerToken(req);
  if (bearer !== undefined) return bearer;
  const queryToken = req.query.token ?? req.query.access_token;
  return typeof queryToken === "string" && queryToken !== "" ? queryToken : undefined;
}

/** Bearer 鉴权：仅当配置了 MCP_AUTH_TOKEN 时启用 */
function createAuthMiddleware(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    const expected = config.mcpAuthToken;
    if (!expected) {
      next();
      return;
    }
    const provided = extractProvidedToken(req);
    if (provided === undefined || !safeEqual(provided, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function requestIdOf(req: Request): string | number | null {
  const body = req.body as { id?: string | number | null } | undefined;
  const id = body?.id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

/**
 * 构建 Express 应用。
 *
 * 路由：
 * - GET  /healthz  存活探针
 * - POST /mcp      Streamable HTTP（无状态）
 * - GET/DELETE /mcp 405（无状态模式不支持 SSE 长连接 / 会话删除）
 */
export function createHttpApp(deps: ServerDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  // 2MB 足够覆盖批量 values；超过时由错误中间件返回 413。
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
  });

  const auth = createAuthMiddleware(deps.config);

  app.post("/mcp", auth, async (req, res) => {
    // 无状态模式：每个请求独立的 server + transport。
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const cleanup = () => {
      void transport.close().catch((err: unknown) => {
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "mcp_transport_close_failed",
        );
      });
      void server.close().catch((err: unknown) => {
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "mcp_server_close_failed",
        );
      });
    };
    res.once("close", cleanup);

    try {
      await server.connect(transport);
      // Accept 头（application/json, text/event-stream）由 SDK 校验与协商，
      // 这里不做改写。
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "mcp_request_failed",
      );
      if (!res.headersSent) {
        res
          .status(500)
          .json(jsonRpcError(requestIdOf(req), -32603, "Internal server error"));
      }
    }
  });

  // ---------------- SSE（有状态；兼容只支持 SSE 的机器人） ----------------
  // 会话保存在进程内，因此按需求单实例部署；多实例时需要粘性会话。
  const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  app.get("/sse", auth, async (req, res) => {
    const server = createMcpServer(deps);
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const closeSession = () => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      sseSessions.delete(sessionId);
      void server.close().catch((err: unknown) => {
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "mcp_sse_close_failed",
        );
      });
    };

    transport.onclose = closeSession;
    res.once("close", closeSession);
    sseSessions.set(sessionId, { transport, server });

    try {
      // server.connect() 内部会调用 transport.start()，向客户端发送 endpoint 事件。
      await server.connect(transport);

      // 部分反向代理 / CDN / 隧道会缓冲较小的响应，导致 SSE 的 endpoint 事件迟迟不到。
      // 追加一段 SSE 注释（客户端会忽略）把首包撑过缓冲阈值。
      if (!res.writableEnded) {
        res.write(`: ${" ".repeat(4096)}\n\n`);
      }
      // 定期心跳，防止空闲连接被代理关闭。
      heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
      }, 15_000);
      heartbeat.unref?.();

      deps.logger.info({ sessionId: sessionId.slice(0, 8) }, "mcp_sse_connected");
    } catch (err) {
      closeSession();
      deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "mcp_sse_connect_failed",
      );
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(null, -32603, "Internal server error"));
      }
    }
  });

  // SSE 模式下客户端把 JSON-RPC 消息 POST 到这里（URL 由 SSE 的 endpoint 事件下发）。
  // 建流时已完成鉴权（Bearer 或 ?token=），此处以不可猜测的 sessionId 作为会话凭据，
  // 兼容不支持自定义请求头的客户端。
  app.post("/messages", async (req, res) => {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    if (!sessionId) {
      res
        .status(400)
        .json(jsonRpcError(requestIdOf(req), -32000, "Missing sessionId"));
      return;
    }

    const session = sseSessions.get(sessionId);
    if (!session) {
      res
        .status(404)
        .json(jsonRpcError(requestIdOf(req), -32000, "Unknown or expired sessionId"));
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "mcp_sse_message_failed",
      );
      if (!res.headersSent) {
        res
          .status(500)
          .json(jsonRpcError(requestIdOf(req), -32603, "Internal server error"));
      }
    }
  });

  app.get("/mcp", auth, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json(
        jsonRpcError(
          null,
          -32000,
          "Method Not Allowed: stateless mode does not support SSE streams; use GET /sse",
        ),
      );
  });

  app.delete("/mcp", auth, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json(
        jsonRpcError(
          null,
          -32000,
          "Method Not Allowed: stateless mode has no session to delete",
        ),
      );
  });

  // 404 兜底
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // 错误处理中间件（含 JSON 解析失败）
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status?: unknown }).status) || 500
        : 500;
    const isBodyParseError =
      err instanceof SyntaxError ||
      (typeof err === "object" &&
        err !== null &&
        (err as { type?: string }).type === "entity.parse.failed");
    const code = isBodyParseError ? -32700 : -32603;
    const message =
      status === 413
        ? "Request entity too large"
        : isBodyParseError
          ? "Parse error"
          : "Internal server error";

    deps.logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        status,
        path: req.path,
      },
      "http_request_error",
    );

    if (res.headersSent) return;
    res
      .status(status >= 400 && status < 600 ? status : 500)
      .json(jsonRpcError(requestIdOf(req), code, message));
  });

  return app;
}
