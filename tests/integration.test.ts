/**
 * 集成测试：使用真实的 registry + 三个真实工具 + 假腾讯文档客户端，
 * 通过 Streamable HTTP 走完整 MCP 调用链（不依赖外网）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import { loadConfig } from "../src/config.js";
import { DAY_MS, isWorkingDay, startOfShanghaiDay } from "../src/utils/date.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  createMockClient,
  getRecordsResponse,
  makeRecord,
  ok,
  type MockClient,
} from "./helpers/tencent.js";
import { textValue } from "../src/utils/values.js";

let httpServer: Server;
let baseUrl: string;
let client: MockClient;

const config = makeTestConfig({ recommendSheetId: undefined });

/** 下一个工作日的 10:00（Asia/Shanghai），用于避开 A09/A10 软规则 */
function nextWorkingDayAt10(): string {
  let cursor = startOfShanghaiDay(Date.now()) + 7 * DAY_MS + 10 * 3_600_000;
  while (!isWorkingDay(cursor, config.workingDays)) cursor += DAY_MS;
  return String(cursor);
}

beforeAll(async () => {
  client = createMockClient();
  client.getRecords.mockResolvedValue(getRecordsResponse([]));
  client.scanRecords.mockResolvedValue({
    records: [],
    scanned: 0,
    truncated: false,
    pages: 1,
  });
  client.addRecords.mockImplementation(async (_f: string, _s: string, req: { records: Array<{ values: unknown }> }) =>
    ok({
      addRecords: {
        records: req.records.map((r, i) => ({ recordID: `rNew${i}`, values: r.values })),
      },
    }),
  );
  client.updateRecords.mockImplementation(async (_f: string, _s: string, req: { records: unknown[] }) =>
    ok({ updateRecords: { records: req.records } }),
  );

  const app = createHttpApp({
    config,
    client,
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

async function rpc(body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    const message = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((msg) => "result" in msg || "error" in msg);
    if (!message) throw new Error(`SSE 响应中没有 JSON-RPC 消息: ${text}`);
    return message;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const message = await rpc({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = message.result as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = result?.content?.[0]?.text ?? "{}";
  return {
    payload: JSON.parse(text) as Record<string, unknown>,
    isError: result?.isError === true,
  };
}

describe("MCP 集成（真实 registry）", () => {
  it("tools/list 暴露三个工具及其必填入参", async () => {
    const message = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (message.result as { tools?: Array<Record<string, unknown>> }).tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      "query_records",
      "update_interview_record",
      "add_interview_record",
    ]);
      for (const tool of tools) {
        const schema = tool.inputSchema as {
          required?: string[];
          properties?: Record<string, unknown>;
        };
        expect(schema.required).toEqual(expect.arrayContaining(["fileID", "sheetID"]));
        expect(schema.properties).toHaveProperty("fileID");
        expect(schema.properties).toHaveProperty("sheetID");
        // 两个写工具的 confidence 为必填
        if (tool.name !== "query_records") {
          expect(schema.required).toContain("confidence");
          expect(schema.properties).toHaveProperty("confidence");
        }
      }
    });

  it("写工具缺少 confidence → MCP 输入校验错误（isError），不调用官方接口", async () => {
    const before = client.updateRecords.mock.calls.length;
    const message = await rpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "update_interview_record",
        arguments: {
          fileID: "file-1",
          sheetID: "interview-1",
          updateRecords: {
            records: [
              {
                recordID: "r1",
                values: {
                  面试评价: [
                    { type: "text", text: "候选人对分布式系统理解深入，建议进入终面。" },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const result = message.result as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("confidence");
    expect(client.updateRecords.mock.calls.length).toBe(before);
  });

  it("query_records 模式 A 走真实 handler 并返回 mcp.mode", async () => {
    const { payload, isError } = await callTool("query_records", {
      fileID: "file-1",
      sheetID: "recommend-1",
      getRecords: { fieldTitles: ["candidate_id", "姓名"], limit: 10 },
    });

    expect(isError).toBe(false);
    expect(payload.ret).toBe(0);
    expect((payload.mcp as Record<string, unknown>).mode).toBe("recommend");
    expect(client.getRecords).toHaveBeenCalledWith("file-1", "recommend-1", {
      fieldTitles: ["candidate_id", "姓名"],
      limit: 10,
    });
  });

  it("update_interview_record 走真实 handler 并写入待确认列", async () => {
    const { payload, isError } = await callTool("update_interview_record", {
      fileID: "file-1",
      sheetID: "interview-1",
      updateRecords: {
        records: [
          {
            recordID: "r1",
            values: {
              是否通过: [{ text: "通过" }],
              面试评价: [{ type: "text", text: "候选人对分布式系统理解深入，建议进入终面。" }],
            },
          },
        ],
      },
      confidence: 0.9,
    });

    expect(isError).toBe(false);
    const mcp = payload.mcp as Record<string, unknown>;
    expect(mcp.status).toBe("updated");
    expect(mcp.pending).toBe(false);
    expect(client.updateRecords).toHaveBeenCalledTimes(1);
    const passed = client.updateRecords.mock.calls[0]![2] as {
      records: Array<{ recordID: string; values: Record<string, unknown> }>;
    };
    expect(Object.keys(passed.records[0]!.values)).toContain("待确认说明");
  });

  it("update_interview_record 拒绝越界字段且不调用官方接口", async () => {
    client.updateRecords.mockClear();
    const { payload, isError } = await callTool("update_interview_record", {
      fileID: "file-1",
      sheetID: "interview-1",
      updateRecords: {
        records: [{ recordID: "r1", values: { 面试阶段: [{ text: "复试" }] } }],
      },
      confidence: 0.9,
    });

    expect(isError).toBe(false);
    expect(payload.ret).toBe(-1);
    expect((payload.mcp as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT");
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  it("add_interview_record 走真实 handler 并只写安排表", async () => {
    const { payload, isError } = await callTool("add_interview_record", {
      fileID: "file-1",
      sheetID: "interview-1",
      addRecords: {
        records: [
          {
            values: {
              candidate_id: textValue("C2026001"),
              姓名: textValue("张三"),
              面试日期: nextWorkingDayAt10(),
              面试阶段: [{ text: "初试" }],
              面试老师: textValue("李老师"),
            },
          },
        ],
      },
      confidence: 0.95,
    });

    expect(isError).toBe(false);
    const mcp = payload.mcp as Record<string, unknown>;
    expect(mcp.status).toBe("created");
    expect(mcp.pending).toBe(false);
    expect(client.addRecords).toHaveBeenCalledTimes(1);
    const passed = client.addRecords.mock.calls[0]![2] as {
      records: Array<{ values: Record<string, unknown> }>;
    };
    expect(Object.keys(passed.records[0]!.values).sort()).toEqual(
      ["candidate_id", "姓名", "面试日期", "面试阶段", "面试老师"].sort(),
    );
  });

  it("缺少凭证时返回 CONFIG_MISSING 且 isError=true", async () => {
    const noCredConfig = loadConfig({ env: {} });
    const app = createHttpApp({
      config: noCredConfig,
      client: createMockClient(),
      logger: createLogger("silent"),
    });
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: {
            name: "query_records",
            arguments: { fileID: "f", sheetID: "s", getRecords: {} },
          },
        }),
      });
      const text = await response.text();
      const rpcMessage = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((msg) => "result" in msg || "error" in msg);
      const parsed = rpcMessage ?? (JSON.parse(text) as Record<string, unknown>);
      const result = parsed.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      const payload = JSON.parse(result.content[0]!.text) as {
        ret: number;
        mcp: { error: { code: string } };
      };
      expect(result.isError).toBe(true);
      expect(payload.ret).toBe(-1);
      expect(payload.mcp.error.code).toBe("CONFIG_MISSING");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("query_records 模式 B 过滤 + 去重（真实 handler + mock 扫描）", async () => {
    client.scanRecords.mockResolvedValueOnce({
      records: [
        makeRecord("r1", {
          candidate_id: textValue("C1"),
          面试日期: "1790000000000",
          是否最新: [{ text: "否" }],
        }),
        makeRecord("r2", {
          candidate_id: textValue("C1"),
          面试日期: "1792000000000",
          是否最新: [{ text: "是" }],
        }),
        makeRecord("r3", {
          candidate_id: textValue("C2"),
          面试日期: "1793000000000",
          是否最新: [{ text: "是" }],
        }),
      ],
      scanned: 3,
      truncated: false,
      pages: 1,
    });

    const { payload } = await callTool("query_records", {
      fileID: "file-1",
      sheetID: "interview-1",
      candidate_id: "C1",
    });

    const data = payload.data as {
      getRecords: { records: Array<{ recordID: string }>; total: number };
    };
    expect(data.getRecords.records.map((r) => r.recordID)).toEqual(["r2"]);
    expect(data.getRecords.total).toBe(1);
    const dedup = (payload.mcp as { dedup: Record<string, unknown> }).dedup;
    expect(dedup.duplicateCount).toBe(2);
    expect(dedup.allRecordIDs).toEqual(["r2", "r1"]);
  });
});
