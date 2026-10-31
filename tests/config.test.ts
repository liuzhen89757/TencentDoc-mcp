import { describe, expect, it } from "vitest";
import { loadConfig, missingCredentials } from "../src/config.js";

describe("loadConfig", () => {
  it("使用文档默认值", () => {
    const config = loadConfig({ env: {} });
    expect(config.confidenceThreshold).toBe(0.8);
    expect(config.maxScanRecords).toBe(1000);
    expect(config.pageSize).toBe(100);
    expect(config.httpPort).toBe(3000);
    expect(config.allowOrphanAdd).toBe(true);
    expect(config.markPending).toBe(true);
    expect(config.fields.pending).toBe("待确认说明");
    expect(config.fields.candidateId).toBe("candidate_id");
    expect(config.fields.interviewResult).toBe("是否通过");
    expect(config.interviewStages).toEqual(["初试", "复试", "终试", "HR面"]);
  });

  it("读取环境变量并校验类型", () => {
    const config = loadConfig({
      env: {
        ACCESS_TOKEN: "token",
        CLIENT_ID: "cid",
        OPEN_ID: "oid",
        CONFIDENCE_THRESHOLD: "0.9",
        MAX_SCAN_RECORDS: "2000",
        PAGE_SIZE: "200",
        ALLOW_ORPHAN_ADD: "false",
        MARK_PENDING: "0",
        PENDING_COLUMN: "人工复核",
        FIELD_NAME: "候选人姓名",
        INTERVIEW_STAGES: "一面,二面",
      },
    });
    expect(config.accessToken).toBe("token");
    expect(config.confidenceThreshold).toBe(0.9);
    expect(config.maxScanRecords).toBe(2000);
    expect(config.pageSize).toBe(100); // 上限 100
    expect(config.allowOrphanAdd).toBe(false);
    expect(config.markPending).toBe(false);
    expect(config.fields.pending).toBe("人工复核");
    expect(config.fields.name).toBe("候选人姓名");
    expect(config.interviewStages).toEqual(["一面", "二面"]);
  });

  it("拒绝非法数字与 JSON", () => {
    expect(() => loadConfig({ env: { CONFIDENCE_THRESHOLD: "abc" } })).toThrow();
    expect(() => loadConfig({ env: { CONFIDENCE_THRESHOLD: "1.5" } })).toThrow();
    expect(() => loadConfig({ env: { RESULT_ALIASES: "not-json" } })).toThrow();
  });

  it("别名表 key 归一化（大小写/空格不敏感）", () => {
    const config = loadConfig({
      env: { RESULT_ALIASES: '{" OK ":"通过","淘汰":"不通过"}' },
    });
    expect(config.resultAliases["ok"]).toBe("通过");
    expect(config.resultAliases["淘汰"]).toBe("不通过");
  });

  it("missingCredentials", () => {
    const config = loadConfig({ env: {} });
    expect(missingCredentials(config)).toEqual(["ACCESS_TOKEN", "CLIENT_ID", "OPEN_ID"]);
    expect(
      missingCredentials(
        loadConfig({ env: { ACCESS_TOKEN: "a", CLIENT_ID: "b", OPEN_ID: "c" } }),
      ),
    ).toEqual([]);
  });
});
