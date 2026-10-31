import { describe, expect, it } from "vitest";
import { withKeyLocks } from "../src/utils/mutex.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withKeyLocks", () => {
  it("同一 key 串行执行", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (name: string) =>
      withKeyLocks(["C1"], async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start-${name}`);
        await delay(10);
        events.push(`end-${name}`);
        active -= 1;
      });

    await Promise.all([task("a"), task("b")]);

    expect(maxActive).toBe(1);
    expect(events).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });

  it("不同 key 可并行执行", async () => {
    let active = 0;
    let maxActive = 0;

    const task = (candidateId: string) =>
      withKeyLocks([candidateId], async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      });

    await Promise.all([task("C1"), task("C2")]);
    expect(maxActive).toBe(2);
  });

  it("多 key 以固定顺序获取，不会死锁", async () => {
    const results: string[] = [];
    await Promise.all([
      withKeyLocks(["a", "b"], async () => {
        await delay(5);
        results.push("ab");
      }),
      withKeyLocks(["b", "a"], async () => {
        await delay(5);
        results.push("ba");
      }),
    ]);
    expect(results.sort()).toEqual(["ab", "ba"]);
  });

  it("任务抛错后仍释放锁", async () => {
    await expect(
      withKeyLocks(["C1"], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(withKeyLocks(["C1"], async () => "ok")).resolves.toBe("ok");
  });
});
