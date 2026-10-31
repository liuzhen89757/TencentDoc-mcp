#!/usr/bin/env node
/**
 * 构建产物冒烟测试：启动 dist/index.js，验证 /healthz、MCP initialize / tools/list /
 * tools/call（无凭证时应返回 CONFIG_MISSING），然后优雅停机。
 *
 * 用法：npm run build && node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import net from "node:net";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // 服务尚未就绪
    }
    if (Date.now() > deadline) throw new Error("等待 /healthz 超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function parseRpc(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    const message = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((msg) => "result" in msg || "error" in msg);
    if (!message) throw new Error(`SSE 中没有 JSON-RPC 消息：${text}`);
    return message;
  }
  return JSON.parse(text);
}

async function rpc(baseUrl, body) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  return parseRpc(await res.text(), res.headers.get("content-type") ?? "");
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

/** 读取 SSE 流中指定 event 的 data */
async function readSseEvent(reader, wanted, timeoutMs = 8000) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`等待 SSE 事件 "${wanted}" 超时`);
    let timer;
    let chunk;
    try {
      chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
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
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (event === wanted) return data;
      index = buffer.indexOf("\n\n");
    }
  }
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = { ...process.env, HTTP_PORT: String(port), LOG_LEVEL: "silent" };
delete env.ACCESS_TOKEN;
delete env.CLIENT_ID;
delete env.OPEN_ID;

const child = spawn(process.execPath, ["dist/index.js"], { env, stdio: "inherit" });
const exit = new Promise((resolve) => child.once("exit", resolve));

try {
  await waitForHealth(baseUrl);
  console.log(`✓ /healthz 200 (${baseUrl})`);

  const init = await rpc(baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1.0.0" },
    },
  });
  assert(init.result?.serverInfo?.name === "tencent-doc-smartbook", "serverInfo.name");
  console.log(`✓ initialize: ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);

  const list = await rpc(baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (list.result?.tools ?? []).map((t) => t.name);
  assert(names.length === 3, "tools/list 应有 3 个工具");
  console.log(`✓ tools/list: ${names.join(", ")}`);

  const call = await rpc(baseUrl, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "query_records",
      arguments: { fileID: "demo-file", sheetID: "demo-sheet", getRecords: {} },
    },
  });
  const payload = JSON.parse(call.result.content[0].text);
  assert(call.result.isError === true, "缺凭证应 isError=true");
  assert(payload.ret === -1, "缺凭证 ret=-1");
  assert(payload.mcp.error.code === "CONFIG_MISSING", "错误码 CONFIG_MISSING");
  console.log(`✓ tools/call 无凭证 → CONFIG_MISSING（isError=true）`);

  // SSE 传输：GET /sse → endpoint 事件 → POST /messages → message 事件
  const sseRes = await fetch(`${baseUrl}/sse`, {
    headers: { Accept: "text/event-stream" },
  });
  assert(sseRes.status === 200, "GET /sse 应返回 200");
  const reader = sseRes.body.getReader();
  try {
    const endpoint = await readSseEvent(reader, "endpoint");
    assert(endpoint.startsWith("/messages?sessionId="), "SSE endpoint 事件格式");
    const post = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke", version: "1.0.0" },
        },
      }),
    });
    assert(post.status === 202, "POST /messages 应返回 202");
    const sseInit = JSON.parse(await readSseEvent(reader, "message"));
    assert(
      sseInit.result?.serverInfo?.name === "tencent-doc-smartbook",
      "SSE initialize serverInfo",
    );
    console.log("✓ SSE /sse + /messages 初始化成功");
  } finally {
    await reader.cancel();
  }

  console.log("SMOKE OK");
} finally {
  child.kill("SIGTERM");
  await Promise.race([exit, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
