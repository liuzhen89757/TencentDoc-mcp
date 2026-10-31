/**
 * HTTP 接入层测试（不依赖真实腾讯文档 API）。
 *
 * 说明：`src/tools/registry.ts` 由其他并行任务维护，测试通过 `vi.mock`
 * 注入三个工具的替身，只验证 server.ts 的注册/路由/鉴权行为。
 * Streamable HTTP 为无状态模式，initialize 与 tools/list 分别在独立
 * 请求中完成（每次请求都会新建 McpServer + Transport）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { makeTestConfig } from "./helpers/config.js";
import { createMockClient } from "./helpers/tencent.js";
import { createLogger } from "../src/logger.js";

vi.mock("../src/tools/registry.js", async () => {
  const { z } = await import("zod");
  const makeTool = (
    name: string,
    title: string,
    annotations: Record<string, unknown>,
  ) => ({
    name,
    title,
    description: `${title}（测试替身）`,
    inputSchema: { fileID: z.string(), sheetID: z.string() },
    annotations,
    handler: async () => ({
      content: [{ type: "text", text: JSON.stringify({ ret: 0, msg: "Succeed", data: {} }) }],
      structuredContent: { ret: 0 },
    }),
  });

  return {
    TOOL_MODULES: [
      makeTool("query_records", "查询记录", { readOnlyHint: true }),
      makeTool("update_interview_record", "更新面试记录", {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      }),
      makeTool("add_interview_record", "新增面试安排", {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      }),
    ],
  };
});

import { createHttpApp } from "../src/server.js";

const AUTH_TOKEN = "test-mcp-token";

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createHttpApp({
    config: makeTestConfig({ mcpAuthToken: AUTH_TOKEN }),
    client: createMockClient(),
    logger: createLogger("silent"),
  });

  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

/** 解析 JSON 或 Streamable HTTP 的 SSE 响应 */
async function readRpcResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (contentType.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const rpc = messages.find(
      (msg) => "result" in msg || "error" in msg,
    );
    if (!rpc) throw new Error(`SSE 响应中没有 JSON-RPC 消息: ${text}`);
    return rpc;
  }

  return JSON.parse(text) as Record<string, unknown>;
}

function postMcp(body: unknown, token: string | null = AUTH_TOKEN): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Streamable HTTP 规范要求同时接受 JSON 与 SSE
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("GET /healthz", () => {
  it("返回 200 与状态/运行时长", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe("Bearer 鉴权", () => {
  it("POST /mcp 未带 Bearer 返回 401", async () => {
    const res = await postMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("POST /mcp 错误 Token 返回 401", async () => {
    const res = await postMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "wrong-token",
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("GET /mcp 带正确 Bearer 返回 405（无状态模式不支持 SSE）", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Accept: "application/json, text/event-stream",
      },
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32000);
  });

  it("DELETE /mcp 带正确 Bearer 返回 405（无会话可删除）", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(405);
  });
});

describe("Streamable HTTP 无状态模式", () => {
  it("initialize 返回 protocolVersion 与 serverInfo", async () => {
    const res = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    });
    expect(res.status).toBe(200);

    const message = await readRpcResponse(res);
    const result = message.result as
      | { protocolVersion?: string; serverInfo?: { name?: string; version?: string } }
      | undefined;
    expect(result?.protocolVersion).toBeTruthy();
    expect(result?.serverInfo?.name).toBe("tencent-doc-smartbook");
    expect(result?.serverInfo?.version).toBe("0.1.0");
  });

  it("tools/list 包含三个工具名", async () => {
    const res = await postMcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(res.status).toBe(200);

    const message = await readRpcResponse(res);
    const result = message.result as
      | { tools?: Array<{ name?: string; inputSchema?: unknown }> }
      | undefined;
    const names = (result?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "query_records",
        "update_interview_record",
        "add_interview_record",
      ]),
    );
    expect(names).toHaveLength(3);
  });
});

describe("兜底路由", () => {
  it("未知路径返回 404 JSON", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });
});
