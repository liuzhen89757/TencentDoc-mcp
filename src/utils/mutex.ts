/**
 * 进程内按 key 互斥锁（需求文档 §12 并发）。
 * 同一 candidate_id 的新增操作串行执行，避免并发重复约面；
 * 不同 key 互不阻塞。多 key 按字典序获取，避免死锁。
 */

const tails = new Map<string, Promise<void>>();

/**
 * 依次获取多个 key 的锁，返回释放函数。
 * 调用方必须在 finally 中释放。
 */
export async function acquireKeyLocks(keys: string[]): Promise<() => void> {
  const uniqueKeys = [...new Set(keys)].sort();
  const releases: Array<() => void> = [];

  try {
    for (const key of uniqueKeys) {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(key, tail);
      releases.push(() => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      });
      // 等待前一个持有者释放
      await previous;
    }
  } catch (err) {
    // 理论上不会失败；防御性释放已获取的锁
    for (const release of releases.reverse()) release();
    throw err;
  }

  return () => {
    for (const release of releases.reverse()) release();
  };
}

/** 便捷包装：在锁内执行 fn */
export async function withKeyLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const release = await acquireKeyLocks(keys);
  try {
    return await fn();
  } finally {
    release();
  }
}
