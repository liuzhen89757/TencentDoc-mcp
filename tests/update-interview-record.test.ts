import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { updateInterviewRecordTool } from "../src/tools/update-interview-record.js";
import type { ToolContext } from "../src/tools/types.js";
import type { ToolCallResult } from "../src/utils/result.js";
import { makeTestConfig } from "./helpers/config.js";
import { apiFail, createMockClient, ok, type MockClient } from "./helpers/tencent.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

type Body = Record<string, any>;
type UpdateCall = [
  string,
  string,
  { records: Array<{ recordID: string; values: Record<string, any> }> },
];

const VALID_FEEDBACK = "候选人对分布式系统理解深入，项目经验匹配，建议进入终面。";

function bodyOf(result: ToolCallResult): Body {
  return result.structuredContent as Body;
}

async function call(
  input: Record<string, unknown>,
  options: { config?: Partial<AppConfig>; client?: MockClient } = {},
): Promise<{ result: ToolCallResult; body: Body; client: MockClient }> {
  const config = makeTestConfig(options.config ?? {});
  const client = options.client ?? createMockClient();
  const ctx: ToolContext = { config, client, logger };
  const result = await updateInterviewRecordTool.handler(input, ctx);
  return { result, body: bodyOf(result), client };
}

function makeInputWithValues(
  values: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    fileID: "file-1",
    sheetID: "sheet-int",
    updateRecords: {
      records: [{ recordID: "r1", values }],
    },
    confidence: 0.9,
    ...extra,
  };
}

function makeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeInputWithValues(
    {
      是否通过: [{ text: "通过" }],
      面试评价: [{ type: "text", text: VALID_FEEDBACK }],
    },
    overrides,
  );
}

function updateCall(client: MockClient, index = 0): UpdateCall {
  return client.updateRecords.mock.calls[index] as UpdateCall;
}

function successClient(): MockClient {
  const client = createMockClient();
  client.updateRecords.mockResolvedValue(
    ok({ updateRecords: { records: [{ recordID: "r1", values: {} }] } }),
  );
  return client;
}

describe("update_interview_record: 工具元信息", () => {
  it("暴露正确的 name / annotations", () => {
    expect(updateInterviewRecordTool.name).toBe("update_interview_record");
    expect(updateInterviewRecordTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(updateInterviewRecordTool.description).toContain("dry_run");
  });
});

describe("update_interview_record: 正常写入", () => {
  it("验收 8/13：confidence=0.9 只写两个业务字段，status=updated，不访问推荐表", async () => {
    const client = successClient();
    const { body } = await call(makeInput(), { client });

    expect(client.updateRecords).toHaveBeenCalledTimes(1);
    const [fileID, sheetID, request] = updateCall(client);
    expect(fileID).toBe("file-1");
    expect(sheetID).toBe("sheet-int");
    expect(request.records).toHaveLength(1);

    const written = request.records[0]!;
    expect(written.recordID).toBe("r1");
    expect(written.values["是否通过"]).toEqual([{ text: "通过" }]);
    expect(written.values["面试评价"]).toEqual([{ type: "text", text: VALID_FEEDBACK }]);
    expect(written.values["待确认说明"]).toEqual([]);
    expect(Object.keys(written.values).sort()).toEqual(
      ["是否通过", "面试评价", "待确认说明"].sort(),
    );

    // 本工具不访问推荐表 / 不查询记录
    expect(client.getRecords).not.toHaveBeenCalled();
    expect(client.addRecords).not.toHaveBeenCalled();

    expect(body.ret).toBe(0);
    expect(body.msg).toBe("Succeed");
    expect(body.data.updateRecords).toBeDefined();
    expect(body.mcp.status).toBe("updated");
    expect(body.mcp.pending).toBe(false);
    expect(body.mcp.confidence).toBe(0.9);
    expect(body.mcp.threshold).toBe(0.8);
    expect(body.mcp.rules).toEqual([]);
  });

  it("验收 9：confidence=0.6 写入待确认说明，status=updated_pending_confirmation", async () => {
    const client = successClient();
    const { body } = await call(makeInput({ confidence: 0.6 }), { client });

    const written = updateCall(client)[2].records[0]!;
    const pendingValue = written.values["待确认说明"];
    expect(Array.isArray(pendingValue)).toBe(true);
    expect(pendingValue).toHaveLength(1);
    expect(pendingValue[0].type).toBe("text");
    expect(pendingValue[0].text).toContain("[MCP待确认]");
    expect(pendingValue[0].text).toContain("confidence=0.60");
    expect(pendingValue[0].text).toContain("rules=S01");

    expect(body.ret).toBe(0);
    expect(body.mcp.status).toBe("updated_pending_confirmation");
    expect(body.mcp.pending).toBe(true);
    expect(body.mcp.rules.map((rule: any) => rule.id)).toContain("S01");
  });

  it("S02：结果=通过但面评含否定词时打标（soft，不拦截写入）", async () => {
    const client = successClient();
    const { body } = await call(
      makeInputWithValues({
        是否通过: [{ text: "通过" }],
        面试评价: [{ type: "text", text: "候选人不符合岗位要求，建议淘汰处理。" }],
      }),
      { client },
    );

    expect(client.updateRecords).toHaveBeenCalledTimes(1);
    expect(body.mcp.rules.map((rule: any) => rule.id)).toContain("S02");
    expect(body.mcp.status).toBe("updated_pending_confirmation");
  });
});

describe("update_interview_record: 归一化与字段清洗", () => {
  it("验收 10：「过」归一化为「通过」", async () => {
    const client = successClient();
    const { body } = await call(
      makeInputWithValues({
        是否通过: [{ text: "过" }],
        面试评价: [{ type: "text", text: VALID_FEEDBACK }],
      }),
      { client },
    );

    const written = updateCall(client)[2].records[0]!;
    expect(written.values["是否通过"]).toEqual([{ text: "通过" }]);
    expect(body.mcp.rules).toEqual([]);
    expect(body.mcp.pending).toBe(false);
  });

  it("验收 10：无法归一化的结果被移除并打 H04，另一字段仍写入", async () => {
    const client = successClient();
    const { body } = await call(
      makeInputWithValues({
        是否通过: [{ text: "可能吧" }],
        面试评价: [{ type: "text", text: VALID_FEEDBACK }],
      }),
      { client },
    );

    expect(client.updateRecords).toHaveBeenCalledTimes(1);
    const written = updateCall(client)[2].records[0]!;
    expect(written.values["是否通过"]).toBeUndefined();
    expect(written.values["面试评价"]).toEqual([{ type: "text", text: VALID_FEEDBACK }]);
    expect(body.mcp.rules.map((rule: any) => rule.id)).toContain("H04");
    expect(body.mcp.status).toBe("updated_pending_confirmation");
  });

  it("验收：面评过短（<10 字）→ 移除 + 待确认", async () => {
    const client = successClient();
    const { body } = await call(
      makeInputWithValues({
        是否通过: [{ text: "通过" }],
        面试评价: [{ type: "text", text: "还不错" }],
      }),
      { client },
    );

    const written = updateCall(client)[2].records[0]!;
    expect(written.values["面试评价"]).toBeUndefined();
    expect(written.values["是否通过"]).toEqual([{ text: "通过" }]);
    expect(body.mcp.rules.map((rule: any) => rule.id)).toContain("H05");
    expect(body.mcp.pending).toBe(true);
    expect(body.mcp.status).toBe("updated_pending_confirmation");
  });

  it("面评超过 5000 字 → 截断 + H05", async () => {
    const client = successClient();
    const longFeedback = "面".repeat(5001);
    const { body } = await call(
      makeInputWithValues({ 面试评价: [{ type: "text", text: longFeedback }] }),
      { client },
    );

    const written = updateCall(client)[2].records[0]!;
    expect(written.values["面试评价"][0].text).toHaveLength(5000);
    expect(body.mcp.rules.map((rule: any) => rule.id)).toContain("H05");
    expect(body.mcp.pending).toBe(true);
  });

  it("多段面评合并为单段官方文本值", async () => {
    const client = successClient();
    const { body } = await call(
      makeInputWithValues({
        面试评价: [
          { type: "text", text: "候选人对分布式系统理解深入，" },
          { type: "text", text: "项目经验匹配，建议进入终面。" },
        ],
      }),
      { client },
    );

    const written = updateCall(client)[2].records[0]!;
    expect(written.values["面试评价"]).toEqual([{ type: "text", text: VALID_FEEDBACK }]);
    expect(body.mcp.sanitized).toBe(true);
  });

  it("confidence 缺失 → INVALID_ARGUMENT，不调用官方接口", async () => {
    const client = createMockClient();
    const input = makeInput();
    delete input.confidence;
    const { body, result } = await call(input, { client });

    expect(body.ret).toBe(-1);
    expect(body.mcp.status).toBe("error");
    expect(body.mcp.error.code).toBe("INVALID_ARGUMENT");
    expect(result.isError).toBeFalsy();
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  it("confidence 非数字/越界 → INVALID_ARGUMENT，不调用官方接口", async () => {
    for (const bad of ["0.9", -0.1, 1.1]) {
      const client = createMockClient();
      const { body } = await call(makeInput({ confidence: bad }), { client });

      expect(body.ret).toBe(-1);
      expect(body.mcp.error.code).toBe("INVALID_ARGUMENT");
      expect(client.updateRecords).not.toHaveBeenCalled();
    }
  });
});

describe("update_interview_record: 参数校验与不可写", () => {
  it("验收 12：values 含面试阶段/面试老师/面试日期 → INVALID_ARGUMENT，不调用官方接口", async () => {
    for (const key of ["面试阶段", "面试老师", "面试日期"]) {
      const client = createMockClient();
      const { body } = await call(
        makeInputWithValues({ [key]: [{ text: "x" }], 面试评价: [{ type: "text", text: VALID_FEEDBACK }] }),
        { client },
      );
      expect(body.ret).toBe(-1);
      expect(body.mcp.error.code).toBe("INVALID_ARGUMENT");
      expect(client.updateRecords).not.toHaveBeenCalled();
    }
  });

  it("验收 12：空 key 也会被拒绝", async () => {
    const client = createMockClient();
    const { body } = await call(
      makeInputWithValues({ "": [{ text: "x" }], 面试评价: [{ type: "text", text: VALID_FEEDBACK }] }),
      { client },
    );
    expect(body.ret).toBe(-1);
    expect(body.mcp.error.code).toBe("INVALID_ARGUMENT");
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  it("两个业务字段都没传 → INVALID_ARGUMENT", async () => {
    const client = createMockClient();
    const { body } = await call(makeInputWithValues({}), { client });
    expect(body.ret).toBe(-1);
    expect(body.mcp.error.code).toBe("INVALID_ARGUMENT");
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  it("只传待确认说明、无业务字段 → INVALID_ARGUMENT", async () => {
    const client = createMockClient();
    const { body } = await call(
      makeInputWithValues({ 待确认说明: [{ type: "text", text: "x" }] }),
      { client },
    );
    expect(body.mcp.error.code).toBe("INVALID_ARGUMENT");
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  it("两个字段都被移除 → NO_WRITABLE_FIELDS，不调用官方接口", async () => {
    const client = createMockClient();
    const { body } = await call(
      makeInputWithValues({
        是否通过: [{ text: "可能吧" }],
        面试评价: [{ type: "text", text: "太短" }],
      }),
      { client },
    );
    expect(body.ret).toBe(-1);
    expect(body.mcp.status).toBe("error");
    expect(body.mcp.error.code).toBe("NO_WRITABLE_FIELDS");
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  it("验收 28：缺 fileID / sheetID → INVALID_ARGUMENT，不调用官方接口", async () => {
    for (const missing of ["fileID", "sheetID"]) {
      const client = createMockClient();
      const input = makeInput();
      delete input[missing];
      const { body } = await call(input, { client });
      expect(body.ret).toBe(-1);
      expect(body.mcp.error.code).toBe("INVALID_ARGUMENT");
      expect(client.updateRecords).not.toHaveBeenCalled();
    }
  });

  it("缺凭证 → CONFIG_MISSING，不调用官方接口", async () => {
    const client = createMockClient();
    const { body } = await call(makeInput(), {
      client,
      config: { accessToken: undefined },
    });
    expect(body.ret).toBe(-1);
    expect(body.mcp.error.code).toBe("CONFIG_MISSING");
    expect(client.updateRecords).not.toHaveBeenCalled();
  });
});

describe("update_interview_record: dry_run", () => {
  it("验收 24：dry_run=true 不调用 client，返回将写入的 values", async () => {
    const client = createMockClient();
    const { body } = await call(makeInput({ dry_run: true }), { client });

    expect(client.updateRecords).not.toHaveBeenCalled();
    expect(body.ret).toBe(0);
    expect(body.msg).toBe("Succeed");
    expect(body.mcp.status).toBe("dry_run");
    expect(body.mcp.pending).toBe(false);

    const records = body.data.updateRecords.records;
    expect(records).toHaveLength(1);
    expect(records[0].recordID).toBe("r1");
    expect(records[0].values["是否通过"]).toEqual([{ text: "通过" }]);
    expect(records[0].values["面试评价"]).toEqual([{ type: "text", text: VALID_FEEDBACK }]);
    expect(records[0].values["待确认说明"]).toEqual([]);
  });
});

describe("update_interview_record: 官方错误", () => {
  it("验收 11：官方错误透传 ret，status=error，不写", async () => {
    const client = createMockClient();
    client.updateRecords.mockResolvedValue(apiFail(10301, "record not found"));
    const { body } = await call(makeInput(), { client });

    expect(client.updateRecords).toHaveBeenCalledTimes(1);
    expect(body.ret).toBe(10301);
    expect(body.msg).toBe("record not found");
    expect(body.mcp.status).toBe("error");
    expect(body.mcp.error.code).toBe("API_ERROR");
    expect(body.data).toEqual({});
  });

  it("验收 22：官方 37019 → AUTH_FAILED", async () => {
    const client = createMockClient();
    client.updateRecords.mockResolvedValue(apiFail(37019, "Token 校验失败，错误或过期"));
    const { body } = await call(makeInput(), { client });

    expect(body.ret).toBe(37019);
    expect(body.mcp.status).toBe("error");
    expect(body.mcp.error.code).toBe("AUTH_FAILED");
    expect(body.mcp.error.hint).toContain("Access-Token");
  });

  it("传输层错误 → 错误响应", async () => {
    const client = createMockClient();
    client.updateRecords.mockResolvedValue({
      ret: -1,
      msg: "请求腾讯文档超时（10000ms）",
      data: {},
      transportError: { code: "TIMEOUT", message: "请求腾讯文档超时（10000ms）", hint: "请稍后重试" },
    });
    const { body } = await call(makeInput(), { client });

    expect(body.ret).toBe(-1);
    expect(body.mcp.status).toBe("error");
    expect(body.mcp.error.code).toBe("TIMEOUT");
    expect(body.mcp.confidence).toBe(0.9);
  });
});

describe("update_interview_record: mark_pending 与批量", () => {
  it("mark_pending=false 时不写待确认列，但 status 仍反映 pending", async () => {
    const client = successClient();
    const { body } = await call(makeInput({ confidence: 0.6, options: { mark_pending: false } }), {
      client,
    });

    const written = updateCall(client)[2].records[0]!;
    expect(Object.prototype.hasOwnProperty.call(written.values, "待确认说明")).toBe(false);
    expect(body.mcp.pending).toBe(true);
    expect(body.mcp.status).toBe("updated_pending_confirmation");
    expect(body.mcp.warnings.length).toBeGreaterThan(0);
  });

  it("批量两条记录、低置信度 → 整体待确认，两条都写入", async () => {
    const client = createMockClient();
    client.updateRecords.mockResolvedValue(
      ok({
        updateRecords: {
          records: [
            { recordID: "r1", values: {} },
            { recordID: "r2", values: {} },
          ],
        },
      }),
    );

    const input = {
      fileID: "file-1",
      sheetID: "sheet-int",
      updateRecords: {
        records: [
          {
            recordID: "r1",
            values: {
              是否通过: [{ text: "通过" }],
              面试评价: [{ type: "text", text: VALID_FEEDBACK }],
            },
          },
          {
            recordID: "r2",
            values: {
              是否通过: [{ text: "不通过" }],
              面试评价: [{ type: "text", text: "候选人技术基础较弱，与岗位要求存在差距。" }],
            },
          },
        ],
      },
      confidence: 0.6,
    };

    const { body } = await call(input, { client });

    expect(client.updateRecords).toHaveBeenCalledTimes(1);
    const request = updateCall(client)[2];
    expect(request.records).toHaveLength(2);
    expect(request.records[0]!.recordID).toBe("r1");
    expect(request.records[1]!.recordID).toBe("r2");
    for (const record of request.records) {
      expect(Array.isArray(record.values["待确认说明"])).toBe(true);
      expect(record.values["待确认说明"]).toHaveLength(1);
    }

    expect(body.mcp.pending).toBe(true);
    expect(body.mcp.status).toBe("updated_pending_confirmation");
    expect(body.data.updateRecords.records).toHaveLength(2);
  });
});
