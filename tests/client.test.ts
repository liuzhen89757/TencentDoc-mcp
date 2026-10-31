import { describe, expect, it, vi } from "vitest";
import { TencentDocsClient } from "../src/tencent/client.js";
import { makeRecord } from "./helpers/tencent.js";

const credentials = {
  accessToken: "token",
  clientId: "client-id",
  openId: "open-id",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successEnvelope(data: unknown) {
  return { ret: 0, msg: "Succeed", data };
}

function getRecordsEnvelope(
  records: unknown[],
  opts: { hasMore?: boolean; next?: number; total?: number } = {},
) {
  return successEnvelope({
    getRecords: {
      hasMore: opts.hasMore ?? false,
      next: opts.next ?? 0,
      total: opts.total ?? records.length,
      records,
    },
  });
}

function createClient(fetchImpl: ReturnType<typeof vi.fn>, overrides = {}) {
  return new TencentDocsClient(credentials, {
    baseUrl: "https://example.com",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
    maxRetries: 2,
    ...overrides,
  });
}

describe("TencentDocsClient", () => {
  it("使用官方路径与三个鉴权头，请求体根键为 getRecords", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(getRecordsEnvelope([])));
    const client = createClient(fetchMock);

    await client.getRecords("f$1", "s 1", { offset: 0, limit: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(
      "https://example.com/openapi/smartbook/v2/files/f%241/sheets/s%201",
    );
    const init = call[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ getRecords: { offset: 0, limit: 2 } });
    const headers = init.headers as Record<string, string>;
    expect(headers["Access-Token"]).toBe("token");
    expect(headers["Client-Id"]).toBe("client-id");
    expect(headers["Open-Id"]).toBe("open-id");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("updateRecords / addRecords 使用正确的根键", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(successEnvelope({ updateRecords: { records: [] } })),
      )
      .mockResolvedValueOnce(jsonResponse(successEnvelope({ addRecords: { records: [] } })));
    const client = createClient(fetchMock);

    await client.updateRecords("f", "s", {
      records: [{ recordID: "r1", values: { 是否通过: [{ text: "通过" }] } }],
    });
    await client.addRecords("f", "s", {
      records: [{ values: { candidate_id: [{ type: "text", text: "C1" }] } }],
    });

    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      updateRecords: { records: [{ recordID: "r1", values: { 是否通过: [{ text: "通过" }] } }] },
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      addRecords: { records: [{ values: { candidate_id: [{ type: "text", text: "C1" }] } }] },
    });
  });

  it("5xx 后指数退避重试并成功", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse(getRecordsEnvelope([])));
    const client = createClient(fetchMock);

    const result = await client.getRecords("f", "s");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ret).toBe(0);
    expect(result.transportError).toBeUndefined();
  });

  it("429 重试耗尽返回 RATE_LIMITED", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    const client = createClient(fetchMock);

    const result = await client.getRecords("f", "s");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.ret).toBe(-1);
    expect(result.transportError?.code).toBe("RATE_LIMITED");
  });

  it("网络错误重试后返回 API_ERROR", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createClient(fetchMock);

    const result = await client.getRecords("f", "s");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.transportError?.code).toBe("API_ERROR");
  });

  it("超时返回 TIMEOUT", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    const client = createClient(fetchMock);

    const result = await client.getRecords("f", "s");
    expect(result.transportError?.code).toBe("TIMEOUT");
  });

  it("官方业务错误不重试，原样透传 ret/msg", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ret: 37019, msg: "Token 校验失败，错误或过期", data: {} }),
    );
    const client = createClient(fetchMock);

    const result = await client.getRecords("f", "s");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ret).toBe(37019);
    expect(result.msg).toBe("Token 校验失败，错误或过期");
    expect(result.transportError).toBeUndefined();
  });

  it("scanRecords 自动翻页直到 hasMore=false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          getRecordsEnvelope(
            [makeRecord("r1", {}), makeRecord("r2", {})],
            { hasMore: true, next: 2, total: 3 },
          ),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(getRecordsEnvelope([makeRecord("r3", {})], { hasMore: false, next: 0 })),
      );
    const client = createClient(fetchMock);

    const result = await client.scanRecords("f", "s", { maxRecords: 1000 });

    expect(result.records.map((r) => r.recordID)).toEqual(["r1", "r2", "r3"]);
    expect(result.scanned).toBe(3);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)).getRecords.offset,
    ).toBe(2);
  });

  it("scanRecords 达到 maxRecords 时截断", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        getRecordsEnvelope([makeRecord("r1", {}), makeRecord("r2", {})], {
          hasMore: true,
          next: 2,
          total: 10,
        }),
      ),
    );
    const client = createClient(fetchMock);

    const result = await client.scanRecords("f", "s", { maxRecords: 2, pageSize: 2 });

    expect(result.records).toHaveLength(2);
    expect(result.scanned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scanRecords 传 recordIDs 时按 100 分块且不分页", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse(getRecordsEnvelope([])),
    );
    const client = createClient(fetchMock);
    const ids = Array.from({ length: 101 }, (_, i) => `r${i}`);

    const result = await client.scanRecords("f", "s", { recordIDs: ids, maxRecords: 1000 });

    expect(result.pages).toBe(2);
    const firstBody = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    ).getRecords;
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1]![1] as RequestInit).body),
    ).getRecords;
    expect(firstBody.recordIDs).toHaveLength(100);
    expect(secondBody.recordIDs).toHaveLength(1);
    expect(firstBody.offset).toBe(0);
  });

  it("scanRecords 遇到官方错误时返回 failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ret: 10313, msg: "Access-Token 为空", data: {} }));
    const client = createClient(fetchMock);

    const result = await client.scanRecords("f", "s");
    expect(result.records).toEqual([]);
    expect(result.failure?.ret).toBe(10313);
    expect(result.failure?.msg).toBe("Access-Token 为空");
  });
});
