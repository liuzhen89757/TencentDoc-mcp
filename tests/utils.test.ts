import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RateLimitExceededError, SlidingWindowLimiter } from "../src/tencent/rate-limiter.js";
import {
  isReasonableInterviewDate,
  isWithinWorkingHours,
  isWorkingDay,
  parseDateMs,
  sameShanghaiDay,
  startOfShanghaiDay,
  toShanghaiIso,
} from "../src/utils/date.js";
import { pickPrimaryRecord, sortRecordIdsByDateDesc } from "../src/utils/dedup.js";
import { normalizeResult, normalizeStage } from "../src/utils/normalize.js";
import { buildPendingText } from "../src/utils/pending.js";
import { extractSelect, extractText, isTruthyFlag, textValue } from "../src/utils/values.js";

const SHANGHAI_1400 = Date.UTC(2026, 10, 7, 6, 0, 0); // 2026-11-07 14:00 +08:00

describe("date", () => {
  it("解析毫秒字符串、秒级时间戳、ISO、中文日期", () => {
    expect(parseDateMs(String(SHANGHAI_1400))).toBe(SHANGHAI_1400);
    expect(parseDateMs(String(SHANGHAI_1400 / 1000))).toBe(SHANGHAI_1400);
    expect(parseDateMs("2026-11-07T14:00:00+08:00")).toBe(SHANGHAI_1400);
    expect(parseDateMs("2026-11-07T06:00:00Z")).toBe(SHANGHAI_1400);
    expect(parseDateMs("2026-11-07 14:00")).toBe(SHANGHAI_1400);
    expect(parseDateMs("2026/11/07 14:00")).toBe(SHANGHAI_1400);
    expect(parseDateMs("2026年11月7日 14时00分")).toBe(SHANGHAI_1400);
    expect(parseDateMs("2026-11-07T14:00:00.000")).toBe(SHANGHAI_1400);
    expect(parseDateMs("2026-11-07 14:00:00.500")).toBe(SHANGHAI_1400);
  });

  it("非法日期返回 undefined", () => {
    expect(parseDateMs("abc")).toBeUndefined();
    expect(parseDateMs("2026-13-01")).toBeUndefined();
    expect(parseDateMs("2026-02-30")).toBeUndefined();
    expect(parseDateMs("")).toBeUndefined();
    expect(parseDateMs(null)).toBeUndefined();
  });

  it("上海时区格式化与同日判断", () => {
    expect(toShanghaiIso(SHANGHAI_1400)).toBe("2026-11-07T14:00:00+08:00");
    const lateNight = Date.UTC(2026, 10, 7, 15, 59, 59); // 23:59:59 +08:00
    expect(sameShanghaiDay(SHANGHAI_1400, lateNight)).toBe(true);
    expect(sameShanghaiDay(SHANGHAI_1400, lateNight + 1000)).toBe(false);
  });

  it("工作日 / 工作时间 / 日期合理性", () => {
    // 2026-11-07 是周六
    expect(isWorkingDay(SHANGHAI_1400, [1, 2, 3, 4, 5])).toBe(false);
    expect(isWorkingDay(SHANGHAI_1400, [6])).toBe(true);
    expect(isWithinWorkingHours(SHANGHAI_1400, { start: 9, end: 20 })).toBe(true);
    expect(
      isWithinWorkingHours(Date.UTC(2026, 10, 7, 12, 0, 0), { start: 9, end: 20 }),
    ).toBe(false); // 20:00 +08:00

    const today = Date.UTC(2026, 10, 30, 4, 0, 0);
    expect(isReasonableInterviewDate(today + 86_400_000, today)).toBe(true);
    expect(isReasonableInterviewDate(startOfShanghaiDay(today) - 1, today)).toBe(false);
    expect(isReasonableInterviewDate(startOfShanghaiDay(today) + 181 * 86_400_000, today)).toBe(
      false,
    );
  });
});

describe("values", () => {
  it("提取文本与单选", () => {
    expect(extractText(textValue("你好"))).toBe("你好");
    expect(extractText([{ text: "a" }, { text: "b" }])).toBe("ab");
    expect(extractText(1760000000000)).toBe("1760000000000");
    expect(extractText(undefined)).toBe("");
    expect(extractSelect([{ text: "通过" }])).toBe("通过");
    expect(extractSelect([])).toBeUndefined();
    expect(isTruthyFlag([{ text: "是" }])).toBe(true);
    expect(isTruthyFlag([{ text: "否" }])).toBe(false);
  });
});

describe("normalize", () => {
  const config = loadConfig({ env: {} });

  it("面试结果别名", () => {
    for (const raw of ["通过", "是", "过", "PASS", "同意录用"]) {
      expect(normalizeResult(raw, config.resultAliases)).toBe("通过");
    }
    expect(normalizeResult("未通过", config.resultAliases)).toBe("不通过");
    expect(normalizeResult("待确认", config.resultAliases)).toBe("待定");
    expect(normalizeResult("可能吧", config.resultAliases)).toBeUndefined();
  });

  it("面试阶段别名与枚举", () => {
    expect(normalizeStage("一面", config.stageAliases, config.interviewStages)).toBe("初试");
    expect(normalizeStage("复试", config.stageAliases, config.interviewStages)).toBe("复试");
    expect(normalizeStage("hr面", config.stageAliases, config.interviewStages)).toBe("HR面");
    expect(normalizeStage("火星面试", config.stageAliases, config.interviewStages)).toBeUndefined();
    expect(normalizeStage("火星面试", config.stageAliases, [])).toBe("火星面试");
  });
});

describe("dedup", () => {
  const record = (id: string, date: string, latest?: string, createTime = "1760000000000") => ({
    recordID: id,
    createTime,
    values: {
      candidate_id: textValue("C1"),
      ...(date ? { 面试日期: date } : {}),
      ...(latest ? { 是否最新: [{ text: latest }] } : {}),
    },
  });

  it("主记录优先级：是否最新 > 面试日期 > createTime", () => {
    const records = [
      record("r1", "1790000000000", undefined, "1760000000000"),
      record("r2", "1780000000000", "是", "1760000000000"),
      record("r3", "1795000000000", undefined, "1760000000000"),
    ];
    expect(pickPrimaryRecord(records, "面试日期", "是否最新")?.recordID).toBe("r2");
  });

  it("无最新标记时取面试日期最大，再取 createTime 最大", () => {
    const records = [
      record("r1", "1790000000000", undefined, "1760000000000"),
      record("r2", "1790000000000", undefined, "1770000000000"),
      record("r3", "1780000000000", undefined, "1780000000000"),
    ];
    expect(pickPrimaryRecord(records, "面试日期", "是否最新")?.recordID).toBe("r2");
    expect(sortRecordIdsByDateDesc(records, "面试日期")).toEqual(["r2", "r1", "r3"]);
  });

  it("空记录返回 undefined", () => {
    expect(pickPrimaryRecord([], "面试日期", "是否最新")).toBeUndefined();
  });
});

describe("pending text", () => {
  it("生成需求文档格式", () => {
    const text = buildPendingText({
      confidence: 0.62,
      threshold: 0.8,
      rules: [
        { id: "S01", level: "soft", message: "置信度低于阈值" },
        { id: "H04", level: "hard", field: "是否通过", message: "无法归一化" },
      ],
      detail: '面试结果"过"无法归一化',
      nowMs: Date.UTC(2026, 9, 30, 6, 5, 0),
      maxLength: 500,
    });
    expect(text).toBe(
      '[MCP待确认] confidence=0.62 (<0.80); rules=S01,H04; detail=面试结果"过"无法归一化; at=2026-10-30T14:05:00+08:00',
    );
  });

  it("超长时截断", () => {
    const text = buildPendingText({
      confidence: 0.1,
      threshold: 0.8,
      rules: [],
      detail: "x".repeat(600),
      maxLength: 50,
    });
    expect(text.length).toBeLessThanOrEqual(50);
  });
});

describe("rate limiter", () => {
  it("超过限额时等待窗口滑动", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new SlidingWindowLimiter({
      limit: 2,
      windowMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await limiter.acquire("k");
    await limiter.acquire("k");
    await limiter.acquire("k"); // 需要等待
    expect(waits.length).toBe(1);
    expect(waits[0]).toBe(1001);
  });

  it("等待超过 maxWaitMs 抛错", async () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      maxWaitMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await limiter.acquire("k");
    await expect(limiter.acquire("k")).rejects.toBeInstanceOf(RateLimitExceededError);
  });
});
