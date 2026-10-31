import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import type { TencentRecord, TencentValue } from "../src/tencent/types.js";
import { addInterviewRecordTool } from "../src/tools/add-interview-record.js";
import type { ToolContext } from "../src/tools/types.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  createMockClient,
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

const FILE_ID = "file-1";
const INTERVIEW_SHEET_ID = "sheet-interview";
const RECOMMEND_SHEET_ID = "sheet-recommend";

/** 测试基准时间：2026-10-30（周五）10:00 Asia/Shanghai */
const NOW_MS = Date.parse("2026-10-30T10:00:00+08:00");
/** 2026-11-02（周一）14:00，正常工作日/工作时间 */
const MONDAY_DATE = String(Date.parse("2026-11-02T14:00:00+08:00"));
/** 2026-10-30（周五）14:00 */
const TODAY_AFTERNOON = String(Date.parse("2026-10-30T14:00:00+08:00"));
/** 2026-10-31（周六）10:00，非工作日 */
const SATURDAY_DATE = String(Date.parse("2026-10-31T10:00:00+08:00"));
/** 2026-10-29（周四）10:00，早于今天 */
const YESTERDAY_DATE = String(Date.parse("2026-10-29T10:00:00+08:00"));

function text(value: string): TencentValue {
  return [{ type: "text", text: value }];
}

function select(value: string): TencentValue {
  return [{ text: value }];
}

function baseValues(
  overrides: Record<string, TencentValue> = {},
): Record<string, TencentValue> {
  return {
    candidate_id: text("C2026001"),
    姓名: text("张三"),
    面试日期: MONDAY_DATE,
    面试阶段: select("初试"),
    面试老师: text("李老师"),
    ...overrides,
  };
}

function makeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fileID: FILE_ID,
    sheetID: INTERVIEW_SHEET_ID,
    addRecords: { records: [{ values: baseValues() }] },
    confidence: 0.92,
    ...overrides,
  };
}

function makeInputWithValues(
  values: Record<string, TencentValue>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeInput({
    addRecords: { records: [{ values }] },
    ...overrides,
  });
}

function scanResult(records: TencentRecord[]) {
  return { records, scanned: records.length, truncated: false, pages: 1 };
}

function mockScan(
  client: MockClient,
  options: { recommend?: TencentRecord[]; interview?: TencentRecord[] } = {},
): void {
  client.scanRecords.mockImplementation(
    async (_fileID: string, sheetID: string) => {
      if (sheetID === RECOMMEND_SHEET_ID) {
        return scanResult(options.recommend ?? []);
      }
      return scanResult(options.interview ?? []);
    },
  );
}

function mockAddSuccess(client: MockClient): void {
  client.addRecords.mockImplementation(
    async (
      _fileID: string,
      _sheetID: string,
      request: { records: Array<{ values: Record<string, TencentValue> }> },
    ) =>
      ok({
        addRecords: {
          records: request.records.map((record, index) => ({
            recordID: `new-${index + 1}`,
            values: record.values,
          })),
        },
      }),
  );
}

function recommendRecord(name: string): TencentRecord {
  return makeRecord("rec-1", {
    candidate_id: text("C2026001"),
    姓名: text(name),
    应聘岗位: text("后端工程师"),
  });
}

function existingInterview(
  recordID: string,
  values: Record<string, TencentValue>,
): TencentRecord {
  return makeRecord(recordID, values);
}

async function invoke(
  input: Record<string, unknown>,
  client: MockClient,
  config: AppConfig = makeTestConfig(),
): Promise<{ result: Awaited<ReturnType<typeof addInterviewRecordTool.handler>>; payload: any }> {
  const ctx: ToolContext = { config, client, logger };
  const result = await addInterviewRecordTool.handler(input, ctx);
  const raw = result.content[0]?.text ?? "{}";
  return { result, payload: JSON.parse(raw) };
}

function ruleIds(payload: any): string[] {
  return (payload.mcp.rules as Array<{ id: string }>).map((rule) => rule.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("add_interview_record 工具定义", () => {
  it("暴露官方路径参数、写工具注解与业务扩展说明", () => {
    expect(addInterviewRecordTool.name).toBe("add_interview_record");
    expect(Object.keys(addInterviewRecordTool.inputSchema).sort()).toEqual(
      [
        "addRecords",
        "confidence",
        "dry_run",
        "fileID",
        "options",
        "recommendSheetID",
        "sheetID",
      ].sort(),
    );
    expect(addInterviewRecordTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(addInterviewRecordTool.description).toContain("只写");
    expect(addInterviewRecordTool.description).toContain("推荐表");
    expect(addInterviewRecordTool.description).toContain("duplicate_policy");
    expect(addInterviewRecordTool.description).toContain("dry_run");
  });
});

describe("验收 14 / 21：正常新增", () => {
  it("只写面试安排表的五个业务字段，推荐表无写请求，status=created", async () => {
    const client = createMockClient();
    mockScan(client, { recommend: [recommendRecord("张三")] });
    mockAddSuccess(client);

    const { result, payload } = await invoke(
      makeInput({ recommendSheetID: RECOMMEND_SHEET_ID }),
      client,
    );

    // 推荐表只读扫描一次 + 安排表重复检测一次
    expect(client.scanRecords).toHaveBeenCalledTimes(2);
    expect(client.scanRecords).toHaveBeenCalledWith(
      FILE_ID,
      RECOMMEND_SHEET_ID,
      {
        maxRecords: makeTestConfig().maxScanRecords,
      },
    );

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    const [fileID, sheetID, request] = client.addRecords.mock.calls[0]!;
    expect(fileID).toBe(FILE_ID);
    expect(sheetID).toBe(INTERVIEW_SHEET_ID);
    // 推荐表没有任何写调用
    for (const call of client.addRecords.mock.calls) {
      expect(call[1]).toBe(INTERVIEW_SHEET_ID);
    }

    const values = request.records[0].values;
    expect(Object.keys(values).sort()).toEqual(
      ["candidate_id", "姓名", "面试日期", "面试阶段", "面试老师"].sort(),
    );
    expect(values["面试日期"]).toBe(MONDAY_DATE);
    expect(values["面试阶段"]).toEqual([{ text: "初试" }]);
    expect(values["姓名"]).toEqual(text("张三"));

    expect(result.isError).toBeFalsy();
    expect(payload.ret).toBe(0);
    expect(payload.msg).toBe("Succeed");
    expect(payload.data.addRecords.records[0].recordID).toBe("new-1");
    expect(payload.mcp.status).toBe("created");
    expect(payload.mcp.duplicate).toBe(false);
    expect(payload.mcp.pending).toBe(false);
    expect(payload.mcp.sanitized).toBe(true);
    expect(payload.mcp.warnings).toEqual([]);
  });
});

describe("验收 15：重复约面", () => {
  it("同候选人同阶段同日重复时不调用 addRecords，返回已有记录，status=duplicate", async () => {
    const client = createMockClient();
    const existing = existingInterview("r-existing", {
      candidate_id: text("C2026001"),
      姓名: text("张三"),
      面试日期: MONDAY_DATE,
      面试阶段: select("初试"),
      面试老师: text("李老师"),
    });
    mockScan(client, { interview: [existing] });

    const { payload } = await invoke(makeInput(), client);

    expect(client.addRecords).not.toHaveBeenCalled();
    expect(payload.ret).toBe(0);
    expect(payload.mcp.status).toBe("duplicate");
    expect(payload.mcp.duplicate).toBe(true);
    expect(payload.data.addRecords.records).toHaveLength(1);
    expect(payload.data.addRecords.records[0].recordID).toBe("r-existing");
    expect(
      payload.mcp.warnings.some((warning: string) =>
        warning.includes("未重复创建"),
      ),
    ).toBe(true);
  });

  it("duplicate_policy=create_anyway 时仍新增并打待确认标记（A12）", async () => {
    const client = createMockClient();
    const existing = existingInterview("r-existing", {
      candidate_id: text("C2026001"),
      姓名: text("张三"),
      面试日期: MONDAY_DATE,
      面试阶段: select("初试"),
      面试老师: text("李老师"),
    });
    mockScan(client, { interview: [existing] });
    mockAddSuccess(client);

    const { payload } = await invoke(
      makeInput({ options: { duplicate_policy: "create_anyway" } }),
      client,
    );

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    expect(payload.mcp.status).toBe("created_pending_confirmation");
    expect(payload.mcp.pending).toBe(true);
    expect(payload.mcp.duplicate).toBe(true);
    expect(ruleIds(payload)).toContain("A12");
    const written = client.addRecords.mock.calls[0]![2].records[0].values;
    expect(written["待确认说明"]).toBeTruthy();
  });
});

describe("验收 16：候选人不存在", () => {
  it("allow_orphan=true → 写入并打标（A06）", async () => {
    const client = createMockClient();
    mockScan(client, { recommend: [] });
    mockAddSuccess(client);

    const { payload } = await invoke(
      makeInput({
        recommendSheetID: RECOMMEND_SHEET_ID,
        options: { allow_orphan: true },
      }),
      client,
    );

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    expect(payload.mcp.status).toBe("created_pending_confirmation");
    expect(payload.mcp.pending).toBe(true);
    expect(ruleIds(payload)).toContain("A06");
  });

  it("allow_orphan=false → CANDIDATE_NOT_FOUND 且不写入", async () => {
    const client = createMockClient();
    mockScan(client, { recommend: [] });

    const { result, payload } = await invoke(
      makeInput({
        recommendSheetID: RECOMMEND_SHEET_ID,
        options: { allow_orphan: false },
      }),
      client,
    );

    expect(client.addRecords).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(payload.ret).toBe(-1);
    expect(payload.mcp.status).toBe("error");
    expect(payload.mcp.error.code).toBe("CANDIDATE_NOT_FOUND");
  });
});

describe("验收 17：低置信度", () => {
  it("写入并返回 created_pending_confirmation，待确认说明非空", async () => {
    const client = createMockClient();
    mockScan(client);
    mockAddSuccess(client);

    const { payload } = await invoke(makeInput({ confidence: 0.5 }), client);

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    expect(payload.mcp.status).toBe("created_pending_confirmation");
    expect(payload.mcp.confidence).toBe(0.5);
    expect(payload.mcp.threshold).toBe(0.8);
    expect(payload.mcp.pending).toBe(true);
    expect(ruleIds(payload)).toContain("A07");
    const written = client.addRecords.mock.calls[0]![2].records[0].values;
    expect(written["待确认说明"][0].text).toContain("MCP待确认");
  });

  it("confidence 缺失/非数字/越界 → INVALID_ARGUMENT，不写入", async () => {
    for (const bad of [undefined, "not-a-number", -0.1, 1.1]) {
      const client = createMockClient();
      mockScan(client);
      mockAddSuccess(client);
      const input = makeInput();
      if (bad === undefined) delete input.confidence;
      else input.confidence = bad;

      const { payload, result } = await invoke(input, client);

      expect(payload.ret).toBe(-1);
      expect(payload.mcp.status).toBe("error");
      expect(payload.mcp.error.code).toBe("INVALID_ARGUMENT");
      expect(result.isError).toBeFalsy();
      expect(client.addRecords).not.toHaveBeenCalled();
    }
  });
});

describe("验收 18：缺面试老师", () => {
  it("仍新增其余字段并打标", async () => {
    const client = createMockClient();
    mockScan(client);
    mockAddSuccess(client);

    const values = baseValues();
    delete values["面试老师"];

    const { payload } = await invoke(makeInputWithValues(values), client);

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    const written = client.addRecords.mock.calls[0]![2].records[0].values;
    expect(written["面试老师"]).toBeUndefined();
    expect(written["candidate_id"]).toEqual(text("C2026001"));
    expect(written["姓名"]).toEqual(text("张三"));
    expect(written["面试日期"]).toBe(MONDAY_DATE);
    expect(written["面试阶段"]).toEqual([{ text: "初试" }]);
    expect(written["待确认说明"]).toBeTruthy();
    expect(payload.mcp.status).toBe("created_pending_confirmation");
    expect(ruleIds(payload)).toContain("A03");
  });
});

describe("验收 19 / 20：非法字段与非法日期", () => {
  it("values 含 是否通过 / 面试评价 → INVALID_ARGUMENT 且不写入", async () => {
    const client = createMockClient();
    mockScan(client);

    const { result, payload } = await invoke(
      makeInputWithValues(
        baseValues({
          是否通过: text("通过"),
          面试评价: text("表现不错"),
        }),
      ),
      client,
    );

    expect(client.scanRecords).not.toHaveBeenCalled();
    expect(client.addRecords).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(payload.ret).toBe(-1);
    expect(payload.mcp.status).toBe("error");
    expect(payload.mcp.error.code).toBe("INVALID_ARGUMENT");
  });

  it("日期格式非法 → 其余字段仍新增、日期留空、打标", async () => {
    const client = createMockClient();
    mockScan(client);
    mockAddSuccess(client);

    const { payload } = await invoke(
      makeInputWithValues(baseValues({ 面试日期: "not-a-date" })),
      client,
    );

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    const written = client.addRecords.mock.calls[0]![2].records[0].values;
    expect(written["面试日期"]).toBeUndefined();
    expect(written["姓名"]).toEqual(text("张三"));
    expect(written["面试阶段"]).toEqual([{ text: "初试" }]);
    expect(written["面试老师"]).toEqual(text("李老师"));
    expect(written["待确认说明"]).toBeTruthy();
    expect(payload.mcp.status).toBe("created_pending_confirmation");
    expect(ruleIds(payload)).toContain("A04");
  });
});

describe("验收 A01：缺 candidate_id", () => {
  it("INVALID_ARGUMENT、说明第几条且不写入", async () => {
    const client = createMockClient();
    mockScan(client);

    const values = baseValues();
    delete values["candidate_id"];

    const { result, payload } = await invoke(makeInputWithValues(values), client);

    expect(client.scanRecords).not.toHaveBeenCalled();
    expect(client.addRecords).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(payload.ret).toBe(-1);
    expect(payload.mcp.error.code).toBe("INVALID_ARGUMENT");
    expect(payload.msg).toContain("第 1 条");
  });
});

describe("姓名权威值与推荐表缺失", () => {
  it("姓名与推荐表不一致 → 以推荐表为准 + 待确认（A08）", async () => {
    const client = createMockClient();
    mockScan(client, { recommend: [recommendRecord("李四")] });
    mockAddSuccess(client);

    const { payload } = await invoke(
      makeInput({ recommendSheetID: RECOMMEND_SHEET_ID }),
      client,
    );

    const written = client.addRecords.mock.calls[0]![2].records[0].values;
    expect(written["姓名"]).toEqual(text("李四"));
    expect(payload.mcp.status).toBe("created_pending_confirmation");
    expect(ruleIds(payload)).toContain("A08");
  });

  it("recommendSheetID 缺失 → 跳过校验 + warning + 正常新增", async () => {
    const client = createMockClient();
    mockScan(client);
    mockAddSuccess(client);

    const { payload } = await invoke(makeInput(), client);

    expect(client.scanRecords).toHaveBeenCalledTimes(1);
    expect(client.scanRecords.mock.calls[0]![1]).toBe(INTERVIEW_SHEET_ID);
    expect(client.addRecords).toHaveBeenCalledTimes(1);
    expect(payload.mcp.status).toBe("created");
    expect(
      payload.mcp.warnings.some((warning: string) =>
        warning.includes("跳过推荐表候选人校验"),
      ),
    ).toBe(true);
    expect(ruleIds(payload)).not.toContain("A06");
  });
});

describe("验收 24：dry_run", () => {
  it("不写表，status=dry_run，返回将写入的 values", async () => {
    const client = createMockClient();
    mockScan(client);

    const { payload } = await invoke(makeInput({ dry_run: true }), client);

    expect(client.addRecords).not.toHaveBeenCalled();
    expect(payload.ret).toBe(0);
    expect(payload.mcp.status).toBe("dry_run");
    expect(payload.data.addRecords.records).toHaveLength(1);
    expect(payload.data.addRecords.records[0].recordID).toBe("");
    expect(payload.data.addRecords.records[0].values["面试阶段"]).toEqual([
      { text: "初试" },
    ]);
  });
});

describe("验收 28：缺少 fileID / sheetID / 凭证", () => {
  it("缺少 fileID → INVALID_ARGUMENT，不调用官方接口", async () => {
    const client = createMockClient();
    const { payload } = await invoke(makeInput({ fileID: "" }), client);

    expect(client.scanRecords).not.toHaveBeenCalled();
    expect(client.addRecords).not.toHaveBeenCalled();
    expect(payload.ret).toBe(-1);
    expect(payload.mcp.error.code).toBe("INVALID_ARGUMENT");
  });

  it("缺少 sheetID → INVALID_ARGUMENT，不调用官方接口", async () => {
    const client = createMockClient();
    const { payload } = await invoke(makeInput({ sheetID: "" }), client);

    expect(client.scanRecords).not.toHaveBeenCalled();
    expect(client.addRecords).not.toHaveBeenCalled();
    expect(payload.ret).toBe(-1);
    expect(payload.mcp.error.code).toBe("INVALID_ARGUMENT");
  });

  it("缺少凭证 → CONFIG_MISSING", async () => {
    const client = createMockClient();
    const config = makeTestConfig({ accessToken: undefined });
    const { result, payload } = await invoke(makeInput(), client, config);

    expect(client.scanRecords).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(payload.ret).toBe(-1);
    expect(payload.mcp.error.code).toBe("CONFIG_MISSING");
  });
});

describe("日期软规则与同日其他轮次（A09 / A10 / A11）", () => {
  it("A09：面试日期早于今天 → 写入并打标", async () => {
    const client = createMockClient();
    mockScan(client);
    mockAddSuccess(client);

    const { payload } = await invoke(
      makeInputWithValues(baseValues({ 面试日期: YESTERDAY_DATE })),
      client,
    );

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    expect(ruleIds(payload)).toContain("A09");
    expect(ruleIds(payload)).not.toContain("A10");
    expect(payload.mcp.status).toBe("created_pending_confirmation");
  });

  it("A10：面试日期落在非工作日 → 写入并打标", async () => {
    const client = createMockClient();
    mockScan(client);
    mockAddSuccess(client);

    const { payload } = await invoke(
      makeInputWithValues(baseValues({ 面试日期: SATURDAY_DATE })),
      client,
    );

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    expect(ruleIds(payload)).toContain("A10");
    expect(ruleIds(payload)).not.toContain("A09");
    expect(payload.mcp.status).toBe("created_pending_confirmation");
  });

  it("A11：同一天该候选人已有其他轮次 → 写入并打标", async () => {
    const client = createMockClient();
    const existing = existingInterview("r-other-stage", {
      candidate_id: text("C2026001"),
      姓名: text("张三"),
      面试日期: TODAY_AFTERNOON,
      面试阶段: select("复试"),
      面试老师: text("王老师"),
    });
    mockScan(client, { interview: [existing] });
    mockAddSuccess(client);

    const { payload } = await invoke(
      makeInputWithValues(baseValues({ 面试日期: TODAY_AFTERNOON })),
      client,
    );

    expect(client.addRecords).toHaveBeenCalledTimes(1);
    expect(ruleIds(payload)).toContain("A11");
    expect(ruleIds(payload)).not.toContain("A09");
    expect(ruleIds(payload)).not.toContain("A10");
    expect(payload.mcp.status).toBe("created_pending_confirmation");
  });
});
