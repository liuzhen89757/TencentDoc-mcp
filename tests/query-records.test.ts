import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import type { TencentValue } from "../src/tencent/types.js";
import { queryRecordsTool } from "../src/tools/query-records.js";
import type { ToolContext } from "../src/tools/types.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  apiFail,
  createMockClient,
  getRecordsResponse,
  makeRecord,
  ok,
  type MockClient,
} from "./helpers/tencent.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** 官方文本值 */
function text(value: string): TencentValue {
  return [{ type: "text", text: value }];
}

async function invoke(
  input: Record<string, unknown>,
  client: MockClient,
  config: AppConfig = makeTestConfig(),
): Promise<{ result: Awaited<ReturnType<typeof queryRecordsTool.handler>>; payload: any }> {
  const ctx: ToolContext = { config, client, logger };
  const result = await queryRecordsTool.handler(input, ctx);
  const raw = result.content[0]?.text ?? "{}";
  return { result, payload: JSON.parse(raw) };
}

/** 模式 B 的扫描结果 */
function scanResult(
  records: ReturnType<typeof makeRecord>[],
  overrides: Partial<{
    scanned: number;
    truncated: boolean;
    pages: number;
    failure: { ret: number; msg: string; transportError?: unknown };
  }> = {},
) {
  return {
    records,
    scanned: overrides.scanned ?? records.length,
    truncated: overrides.truncated ?? false,
    pages: overrides.pages ?? 1,
    ...(overrides.failure ? { failure: overrides.failure } : {}),
  };
}

describe("query_records 工具定义", () => {
  it("暴露官方参数、只读注解与模式说明", () => {
    expect(queryRecordsTool.name).toBe("query_records");
    expect(Object.keys(queryRecordsTool.inputSchema).sort()).toEqual(
      ["candidate_id", "fileID", "getRecords", "options", "sheetID"].sort(),
    );
    expect(queryRecordsTool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(queryRecordsTool.description).toContain("offset");
    expect(queryRecordsTool.description).toContain("limit");
    expect(queryRecordsTool.description).toContain("去重");
    expect(queryRecordsTool.description).toContain("sheetID");
  });
});

describe("模式 A：不传 candidate_id（官方直通）", () => {
  it("只调用一次 getRecords，透传 fileID/sheetID/请求体并返回 recommend", async () => {
    const client = createMockClient();
    const records = [
      makeRecord("rRec01", { candidate_id: text("C2026001"), 姓名: text("张三") }),
    ];
    client.getRecords.mockResolvedValue(
      getRecordsResponse(records, { hasMore: true, next: 1, total: 120 }),
    );

    const { result, payload } = await invoke(
      {
        fileID: "file-1",
        sheetID: "sheet-rec",
        getRecords: {
          viewID: "view-1",
          recordIDs: ["rRec01"],
          fieldTitles: ["candidate_id", "姓名"],
          sort: [{ fieldTitle: "推荐日期", desc: true }],
          offset: 0,
          limit: 1,
        },
      },
      client,
    );

    expect(client.getRecords).toHaveBeenCalledTimes(1);
    expect(client.getRecords).toHaveBeenCalledWith("file-1", "sheet-rec", {
      viewID: "view-1",
      recordIDs: ["rRec01"],
      fieldTitles: ["candidate_id", "姓名"],
      sort: [{ fieldTitle: "推荐日期", desc: true }],
      offset: 0,
      limit: 1,
    });
    expect(client.scanRecords).not.toHaveBeenCalled();

    expect(payload.ret).toBe(0);
    expect(payload.msg).toBe("Succeed");
    expect(payload.data.getRecords).toMatchObject({ hasMore: true, next: 1, total: 120 });
    expect(payload.data.getRecords.records).toHaveLength(1);
    expect(payload.data.getRecords.records[0].recordID).toBe("rRec01");
    expect(payload.mcp).toEqual({
      mode: "recommend",
      scanned: 1,
      truncated: false,
      warnings: [],
    });
    expect(result.isError).toBeUndefined();
  });

  it("未提供的官方字段不会出现在请求体中（可缺省为 {}）", async () => {
    const client = createMockClient();
    client.getRecords.mockResolvedValue(getRecordsResponse([]));

    await invoke({ fileID: "f", sheetID: "s", getRecords: { offset: 0 } }, client);
    expect(client.getRecords).toHaveBeenLastCalledWith("f", "s", { offset: 0 });

    await invoke({ fileID: "f", sheetID: "s" }, client);
    expect(client.getRecords).toHaveBeenLastCalledWith("f", "s", {});
  });

  it("官方 ret!=0 时透传 ret/msg 并归类错误", async () => {
    const client = createMockClient();
    client.getRecords.mockResolvedValue(apiFail(37019, "Token 校验失败，错误或过期"));

    const { result, payload } = await invoke({ fileID: "f", sheetID: "s" }, client);

    expect(payload.ret).toBe(37019);
    expect(payload.msg).toBe("Token 校验失败，错误或过期");
    expect(payload.data).toEqual({});
    expect(payload.mcp.mode).toBe("recommend");
    expect(payload.mcp.warnings).toEqual([]);
    expect(payload.mcp.error.code).toBe("AUTH_FAILED");
    expect(result.isError).toBe(true);
  });

  it("传输层错误使用 transportErrorResponse", async () => {
    const client = createMockClient();
    client.getRecords.mockResolvedValue({
      ret: -1,
      msg: "请求腾讯文档超时（10000ms）",
      data: {},
      transportError: { code: "TIMEOUT", message: "请求腾讯文档超时（10000ms）" },
    });

    const { result, payload } = await invoke({ fileID: "f", sheetID: "s" }, client);

    expect(payload.ret).toBe(-1);
    expect(payload.mcp.mode).toBe("recommend");
    expect(payload.mcp.error.code).toBe("TIMEOUT");
    // TIMEOUT 不是协议级错误
    expect(result.isError).toBeUndefined();
  });
});

describe("模式 B：传 candidate_id（过滤 + 去重）", () => {
  it("只保留目标候选人，3 条记录去重为 1 条主记录", async () => {
    const client = createMockClient();
    const records = [
      makeRecord("rInterview01", {
        candidate_id: text("C2026001"),
        面试日期: "1760000000000",
        是否最新: text("否"),
      }),
      makeRecord("rInterview02", {
        candidate_id: text("C2026001"),
        面试日期: "1770000000000",
        是否最新: text("否"),
      }),
      makeRecord("rInterview03", {
        candidate_id: text("C2026001"),
        面试日期: "1780000000000",
        是否最新: text("否"),
      }),
      makeRecord("rOther", {
        candidate_id: text("C2026999"),
        面试日期: "1790000000000",
        是否最新: text("是"),
      }),
    ];
    client.scanRecords.mockResolvedValue(scanResult(records, { scanned: 4 }));

    const { payload } = await invoke(
      { fileID: "file-1", sheetID: "sheet-int", candidate_id: "C2026001" },
      client,
    );

    expect(client.getRecords).not.toHaveBeenCalled();
    expect(client.scanRecords).toHaveBeenCalledTimes(1);
    expect(client.scanRecords).toHaveBeenCalledWith("file-1", "sheet-int", {
      maxRecords: 1000,
      pageSize: 100,
    });

    expect(payload.ret).toBe(0);
    expect(payload.msg).toBe("Succeed");
    expect(payload.data.getRecords).toMatchObject({ hasMore: false, next: 0, total: 1 });
    expect(payload.data.getRecords.records).toHaveLength(1);
    expect(payload.data.getRecords.records[0].recordID).toBe("rInterview03");
    expect(payload.mcp).toEqual({
      mode: "interview",
      candidate_id: "C2026001",
      dedup: {
        applied: true,
        primaryRecordID: "rInterview03",
        allRecordIDs: ["rInterview03", "rInterview02", "rInterview01"],
        duplicateCount: 3,
      },
      scanned: 4,
      truncated: false,
      warnings: [],
    });
  });

  it("主记录优先取「是否最新=是」，即使面试日期更早", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult([
        makeRecord("rLatestOld", {
          candidate_id: text("C1"),
          面试日期: "1760000000000",
          是否最新: text("是"),
        }),
        makeRecord("rNewer", {
          candidate_id: text("C1"),
          面试日期: "1790000000000",
          是否最新: text("否"),
        }),
      ]),
    );

    const { payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C1" },
      client,
    );

    expect(payload.mcp.dedup.primaryRecordID).toBe("rLatestOld");
    expect(payload.mcp.dedup.allRecordIDs).toEqual(["rNewer", "rLatestOld"]);
  });

  it("无「是否最新」标记时取面试日期最大", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult([
        makeRecord(
          "rEarly",
          { candidate_id: text("C1"), 面试日期: "1760000000000" },
          { createTime: "1760000000000" },
        ),
        makeRecord(
          "rLate",
          { candidate_id: text("C1"), 面试日期: "1790000000000" },
          { createTime: "1700000000000" },
        ),
      ]),
    );

    const { payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C1" },
      client,
    );

    expect(payload.mcp.dedup.primaryRecordID).toBe("rLate");
    expect(payload.mcp.dedup.allRecordIDs).toEqual(["rLate", "rEarly"]);
  });

  it("面试日期相同时取 createTime 最大", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult([
        makeRecord(
          "rOlderCreate",
          { candidate_id: text("C1"), 面试日期: "1760000000000" },
          { createTime: "1760000000100" },
        ),
        makeRecord(
          "rNewerCreate",
          { candidate_id: text("C1"), 面试日期: "1760000000000" },
          { createTime: "1760000000900" },
        ),
      ]),
    );

    const { payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C1" },
      client,
    );

    expect(payload.mcp.dedup.primaryRecordID).toBe("rNewerCreate");
    expect(payload.mcp.dedup.allRecordIDs).toEqual(["rNewerCreate", "rOlderCreate"]);
  });

  it("表中无该候选人时返回空结果与约面提示", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult([
        makeRecord("rOther", {
          candidate_id: text("C2026999"),
          面试日期: "1790000000000",
        }),
      ]),
    );

    const { result, payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C2026001" },
      client,
    );

    expect(payload.ret).toBe(0);
    expect(payload.data.getRecords).toEqual({
      hasMore: false,
      next: 0,
      total: 0,
      records: [],
    });
    expect(payload.mcp).toEqual({
      mode: "interview",
      candidate_id: "C2026001",
      dedup: {
        applied: true,
        primaryRecordID: "",
        allRecordIDs: [],
        duplicateCount: 0,
      },
      scanned: 1,
      truncated: false,
      warnings: ["该候选人在面试安排表中暂无记录，可调用 add_interview_record 约面。"],
    });
    expect(result.isError).toBeUndefined();
  });

  it("truncated=true 时原样透传", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult(
        [
          makeRecord("r1", {
            candidate_id: text("C1"),
            面试日期: "1790000000000",
          }),
        ],
        { scanned: 5000, truncated: true, pages: 50 },
      ),
    );

    const { payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C1" },
      client,
    );

    expect(payload.ret).toBe(0);
    expect(payload.mcp.scanned).toBe(5000);
    expect(payload.mcp.truncated).toBe(true);
  });

  it("offset/limit 不用于官方分页：pageSize 取自 limit，offset 不透传", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult([
        makeRecord("r1", { candidate_id: text("C1"), 面试日期: "1790000000000" }),
      ]),
    );

    const { payload } = await invoke(
      {
        fileID: "f",
        sheetID: "s",
        candidate_id: "C1",
        getRecords: {
          offset: 30,
          limit: 50,
          fieldTitles: ["candidate_id", "面试日期"],
          recordIDs: ["r1"],
        },
        options: { max_records: 4000 },
      },
      client,
    );

    expect(client.scanRecords).toHaveBeenCalledWith("f", "s", {
      recordIDs: ["r1"],
      maxRecords: 4000,
      pageSize: 50,
    });
    expect(client.getRecords).not.toHaveBeenCalled();
    expect(payload.mcp.warnings).toEqual([
      expect.stringContaining("fieldTitles"),
    ]);
  });

  it("pageSize 最大 100，max_records 受 MAX_SCAN_RECORDS_CAP 限制", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(scanResult([]));

    await invoke(
      {
        fileID: "f",
        sheetID: "s",
        candidate_id: "C1",
        getRecords: { limit: 500 },
      },
      client,
    );
    expect(client.scanRecords).toHaveBeenLastCalledWith("f", "s", {
      maxRecords: 1000,
      pageSize: 100,
    });

    const cappedConfig = makeTestConfig({ maxScanRecords: 9000, maxScanRecordsCap: 5000 });
    await invoke({ fileID: "f", sheetID: "s", candidate_id: "C1" }, client, cappedConfig);
    expect(client.scanRecords).toHaveBeenLastCalledWith("f", "s", {
      maxRecords: 5000,
      pageSize: 100,
    });
  });

  it("扫描时官方 ret!=0 透传为错误响应（mode=interview）", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult([], {
        scanned: 10,
        failure: { ret: 37019, msg: "Token 校验失败，错误或过期" },
      }),
    );

    const { result, payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C1" },
      client,
    );

    expect(payload.ret).toBe(37019);
    expect(payload.msg).toBe("Token 校验失败，错误或过期");
    expect(payload.mcp.mode).toBe("interview");
    expect(payload.mcp.candidate_id).toBe("C1");
    expect(payload.mcp.error.code).toBe("AUTH_FAILED");
    expect(result.isError).toBe(true);
  });

  it("扫描时传输层错误使用 transportErrorResponse", async () => {
    const client = createMockClient();
    client.scanRecords.mockResolvedValue(
      scanResult([], {
        failure: {
          ret: -1,
          msg: "触发腾讯文档频控，等待超时",
          transportError: { code: "RATE_LIMITED", message: "触发腾讯文档频控，等待超时" },
        },
      }),
    );

    const { result, payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C1" },
      client,
    );

    expect(payload.ret).toBe(-1);
    expect(payload.mcp.mode).toBe("interview");
    expect(payload.mcp.error.code).toBe("RATE_LIMITED");
    expect(result.isError).toBeUndefined();
  });
});

describe("参数与配置错误", () => {
  it.each([
    ["缺 fileID", { sheetID: "s" }],
    ["缺 sheetID", { fileID: "f" }],
    ["fileID 为空白", { fileID: "   ", sheetID: "s" }],
    ["两者都缺", {}],
  ])("%s → ret=-1 / INVALID_ARGUMENT，且不调用 client", async (_label, input) => {
    const client = createMockClient();

    const { result, payload } = await invoke(input, client);

    expect(payload.ret).toBe(-1);
    expect(payload.mcp.error.code).toBe("INVALID_ARGUMENT");
    expect(payload.data).toEqual({});
    expect(client.getRecords).not.toHaveBeenCalled();
    expect(client.scanRecords).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it("缺少 fileID / sheetID 时 msg 明确指出缺失字段", async () => {
    const client = createMockClient();

    const missingFile = await invoke({ sheetID: "s" }, client);
    expect(missingFile.payload.msg).toBe("缺少 fileID");
    expect(missingFile.payload.mcp.error.hint).toContain("fileID");

    const missingSheet = await invoke({ fileID: "f" }, client);
    expect(missingSheet.payload.msg).toBe("缺少 sheetID");
  });

  it("max_records 超出 1-5000 时返回 INVALID_ARGUMENT", async () => {
    const client = createMockClient();
    const { payload } = await invoke(
      { fileID: "f", sheetID: "s", candidate_id: "C1", options: { max_records: 6000 } },
      client,
    );

    expect(payload.ret).toBe(-1);
    expect(payload.mcp.error.code).toBe("INVALID_ARGUMENT");
    expect(client.scanRecords).not.toHaveBeenCalled();
  });

  it("缺凭证 → ret=-1 / CONFIG_MISSING，且不调用 client", async () => {
    const client = createMockClient();
    const config = makeTestConfig({ accessToken: undefined });

    const { result, payload } = await invoke({ fileID: "f", sheetID: "s" }, client, config);

    expect(payload.ret).toBe(-1);
    expect(payload.mcp.error.code).toBe("CONFIG_MISSING");
    expect(payload.mcp.error.message).toContain("ACCESS_TOKEN");
    expect(client.getRecords).not.toHaveBeenCalled();
    expect(client.scanRecords).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});
