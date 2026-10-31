/**
 * 进程入口：加载配置 → 构建客户端/应用 → 监听端口 → 优雅停机。
 *
 * 凭证缺失时服务仍启动，工具调用会返回 CONFIG_MISSING（需求文档 6.1）。
 * 启动日志只输出「是否配置」，绝不输出任何密钥值。
 */
import { loadConfig, missingCredentials } from "./config.js";
import { createLogger } from "./logger.js";
import { createHttpApp, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { TencentDocsClient } from "./tencent/client.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const missing = missingCredentials(config);
  const client = new TencentDocsClient(
    {
      accessToken: config.accessToken ?? "",
      clientId: config.clientId ?? "",
      openId: config.openId ?? "",
    },
    {
      baseUrl: config.apiBaseUrl,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      retryDelaysMs: config.retryDelaysMs,
      rateLimit: config.rateLimit,
      logger,
    },
  );

  const app = createHttpApp({ config, client, logger });
  const httpServer = app.listen(config.httpPort, () => {
    logger.info(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        port: config.httpPort,
        bearerAuthEnabled: Boolean(config.mcpAuthToken),
        credentialsConfigured: missing.length === 0,
        missingCredentials: missing,
      },
      "mcp_server_started",
    );
  });

  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "mcp_server_shutting_down");

    const forceTimer = setTimeout(() => {
      logger.error({ reason, timeoutMs: SHUTDOWN_TIMEOUT_MS }, "mcp_server_force_exit");
      httpServer.closeAllConnections?.();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // 不阻止进程因其他原因退出
    forceTimer.unref();

    // 停止接受新连接，等待现有请求结束
    httpServer.close((err) => {
      clearTimeout(forceTimer);
      if (err) {
        logger.error({ err: err.message }, "mcp_server_shutdown_error");
        process.exit(1);
      }
      logger.info({ reason }, "mcp_server_stopped");
      process.exit(0);
    });
    httpServer.closeIdleConnections?.();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error(
      {
        err: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      "unhandled_rejection",
    );
  });

  process.on("uncaughtException", (err) => {
    logger.error({ err: err.message, stack: err.stack }, "uncaught_exception");
    shutdown("uncaughtException");
  });

  httpServer.on("error", (err) => {
    logger.error({ err: err.message }, "http_server_error");
    shutdown("http_server_error");
  });
}

try {
  main();
} catch (err) {
  // 配置非法等启动期错误：此时 logger 可能尚未创建，退化为 stderr。
  // eslint-disable-next-line no-console
  console.error(
    "[tencent-doc-smartbook] 启动失败：",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
