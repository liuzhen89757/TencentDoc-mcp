/** 进程内滑动窗口限流（需求文档 5.4：fileID 120/min、openID 250/min） */

export class RateLimitExceededError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`等待限流窗口超过上限（已等待 ${waitedMs}ms）`);
    this.name = "RateLimitExceededError";
  }
}

export interface SlidingWindowLimiterOptions {
  limit: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 单次 acquire 最长等待时间，超过则抛 RateLimitExceededError */
  maxWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SlidingWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(options: SlidingWindowLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.maxWaitMs = options.maxWaitMs ?? 60_000;
  }

  /** 等待到可以用一个配额；返回实际等待毫秒数 */
  async acquire(key: string): Promise<number> {
    let waited = 0;
    for (;;) {
      const now = this.now();
      const hits = (this.buckets.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
      if (hits.length < this.limit) {
        hits.push(now);
        this.buckets.set(key, hits);
        return waited;
      }
      const oldest = hits[0] ?? now;
      const waitMs = Math.max(1, this.windowMs - (now - oldest) + 1);
      if (waited + waitMs > this.maxWaitMs) {
        throw new RateLimitExceededError(waited + waitMs);
      }
      await this.sleep(waitMs);
      waited += waitMs;
    }
  }

  /** 仅供测试/观测 */
  size(key: string): number {
    return this.buckets.get(key)?.length ?? 0;
  }

  reset(): void {
    this.buckets.clear();
  }
}
