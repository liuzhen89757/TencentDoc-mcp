/**
 * SSE 传输测试：验证 GET /sse + POST /messages 的完整 MCP 调用链。
 * 使用真实 registry + 假腾讯文档客户端，不访问外网。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import { makeTestConfig } from "./helpers/config.js";
import { createMockClient, getRecordsResponse, type MockClient } from "./helpers/tencent.js";

const AUTH_TOKEN = "sse-test-token";
const config = makeTestConfig({ mcpAuthToken: AUTH_TOKEN });

let httpServer: Server;
let baseUrl: string;
let client: MockClient;

beforeAll(async () => {
  client = createMockClient();
  client.getRecords.mockResolvedValue(getRecordsResponse([]));

  const app = createHttpApp({ config, client, logger: createLogger("silent") });
  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  httpServer.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

/** 读取 SSE 流中指定 event 的 data（支持多行 data，自动处理分块） */
async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wanted: string,
  timeoutMs = 8000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`等待 SSE 事件 "${wanted}" 超时`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`等待 SSE 事件 "${wanted}" 超时`)),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (chunk.done) throw new Error("SSE 连接已关闭");
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");

    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "message";
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (event === wanted) return data;
      index = buffer.indexOf("\n\n");
    }
  }
}

async function postMessage(
  endpoint: string,
  body: unknown,
  token: string | null = AUTH_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function openSse(path = "/sse", token: string | null = AUTH_TOKEN) {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { headers });
}

describe("SSE 传输", () => {
  it("未鉴权访问 /sse 返回 401", async () => {
    const res = await openSse("/sse", null);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("支持 ?token= 查询参数鉴权（兼容不支持请求头的客户端）", async () => {
    const res = await openSse(`/sse?token=${AUTH_TOKEN}`, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    try {
      const endpoint = await readEvent(reader, "endpoint");
      expect(endpoint).toMatch(/^\/messages\?sessionId=/);
    } finally {
      await reader.cancel();
    }
  });

  it("initialize / tools/list / tools/call 全链路", async () => {
    const sse = await openSse();
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");

    const reader = sse.body!.getReader();
    try {
      const endpoint = await readEvent(reader, "endpoint");
      expect(endpoint).toMatch(/^\/messages\?sessionId=/);

      // initialize
      const initRes = await postMessage(endpoint, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "sse-test", version: "1.0.0" },
        },
      });
      expect(initRes.status).toBe(202);
      const init = JSON.parse(await readEvent(reader, "message")) as {
        result: { serverInfo: { name: string } };
      };
      expect(init.result.serverInfo.name).toBe("tencent-doc-smartbook");

      // tools/list
      const listRes = await postMessage(endpoint, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      expect(listRes.status).toBe(202);
      const list = JSON.parse(await readEvent(reader, "message")) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(list.result.tools.map((tool) => tool.name)).toEqual([
        "query_records",
        "update_interview_record",
        "add_interview_record",
      ]);

      // tools/call（真实 handler + mock 客户端）
      const callRes = await postMessage(endpoint, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "query_records",
          arguments: { fileID: "file-1", sheetID: "sheet-1", getRecords: {} },
        },
      });
      expect(callRes.status).toBe(202);
      const call = JSON.parse(await readEvent(reader, "message")) as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      };
      const payload = JSON.parse(call.result.content[0]!.text) as {
        ret: number;
        mcp: { mode: string };
      };
      expect(call.result.isError).not.toBe(true);
      expect(payload.ret).toBe(0);
      expect(payload.mcp.mode).toBe("recommend");
      expect(client.getRecords).toHaveBeenCalledWith("file-1", "sheet-1", {});
    } finally {
      await reader.cancel();
    }
  });

  it("缺少 sessionId 返回 400，未知 sessionId 返回 404", async () => {
    const missing = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(400);

    const unknown = await fetch(`${baseUrl}/messages?sessionId=${randomUUID()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unknown.status).toBe(404);
  });
});
