import { vi, type Mock } from "vitest";
import type { TencentDocsClient } from "../../src/tencent/client.js";
import type { TencentRecord, TencentValue } from "../../src/tencent/types.js";

export type MockClient = TencentDocsClient & {
  getRecords: Mock;
  updateRecords: Mock;
  addRecords: Mock;
  scanRecords: Mock;
};

export function createMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    getRecords: vi.fn(),
    updateRecords: vi.fn(),
    addRecords: vi.fn(),
    scanRecords: vi.fn(),
    ...overrides,
  } as unknown as MockClient;
}

/** 官方成功响应 */
export function ok<T>(data: T) {
  return { ret: 0, msg: "Succeed", data };
}

/** 官方业务错误响应 */
export function apiFail(ret: number, msg = "error") {
  return { ret, msg, data: {} };
}

export function makeRecord(
  recordID: string,
  values: Record<string, TencentValue>,
  times: { createTime?: string; updateTime?: string } = {},
): TencentRecord {
  return {
    recordID,
    createTime: times.createTime ?? "1760000000000",
    updateTime: times.updateTime ?? times.createTime ?? "1760000000000",
    values,
  };
}

export function getRecordsResponse(
  records: TencentRecord[],
  opts: { hasMore?: boolean; next?: number; total?: number } = {},
) {
  return ok({
    getRecords: {
      hasMore: opts.hasMore ?? false,
      next: opts.next ?? 0,
      total: opts.total ?? records.length,
      records,
    },
  });
}
