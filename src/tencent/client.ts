/**
 * 腾讯文档智能表 OpenAPI 客户端。
 * - 鉴权头：Access-Token / Client-Id / Open-Id
 * - 三接口共用 URL，靠请求体根键区分（需求文档 5.1）
 * - 限流（5.4）、超时、429/5xx/网络错误指数退避重试
 */
import type { Logger } from "../logger.js";
import { classifyHttpStatus, mcpError, type McpError } from "./errors.js";
import { RateLimitExceededError, SlidingWindowLimiter } from "./rate-limiter.js";
import type {
  AddRecordsData,
  AddRecordsRequest,
  GetRecordsData,
  GetRecordsRequest,
  TencentApiEnvelope,
  TencentRecord,
  UpdateRecordsData,
  UpdateRecordsRequest,
} from "./types.js";

export interface TencentCredentials {
  accessToken: string;
  clientId: string;
  openId: string;
}

export interface TencentDocsClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelaysMs?: number[];
  rateLimit?: {
    filePerMinute?: number;
    openIdPerMinute?: number;
  };
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 客户端统一返回；transportError 有值时表示未拿到官方 JSON 响应 */
export interface ApiEnvelope<T> {
  ret: number;
  msg: string;
  data: T;
  transportError?: McpError;
}

export interface ScanOptions {
  fieldTitles?: string[];
  recordIDs?: string[];
  maxRecords?: number;
  pageSize?: number;
  viewID?: string;
  sort?: Array<{ fieldTitle: string; desc?: boolean }>;
}

export interface ScanResult {
  records: TencentRecord[];
  scanned: number;
  truncated: boolean;
  pages: number;
  /** 扫描中途官方报错或传输失败时携带 */
  failure?: {
    ret: number;
    msg: string;
    transportError?: McpError;
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TencentDocsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelaysMs: number[];
  private readonly logger?: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fileLimiter: SlidingWindowLimiter;
  private readonly openIdLimiter: SlidingWindowLimiter;

  constructor(
    private readonly credentials: TencentCredentials,
    options: TencentDocsClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://docs.qq.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1500];
    this.logger = options.logger;
    this.sleep = options.sleep ?? defaultSleep;
    this.fileLimiter = new SlidingWindowLimiter({
      limit: options.rateLimit?.filePerMinute ?? 120,
      now: options.now,
      sleep: this.sleep,
    });
    this.openIdLimiter = new SlidingWindowLimiter({
      limit: options.rateLimit?.openIdPerMinute ?? 250,
      now: options.now,
      sleep: this.sleep,
    });
  }

  private buildUrl(fileID: string, sheetID: string): string {
    return `${this.baseUrl}/openapi/smartbook/v2/files/${encodeURIComponent(fileID)}/sheets/${encodeURIComponent(sheetID)}`;
  }

  private envelopeFromTransportError<T>(error: McpError, msg: string): ApiEnvelope<T> {
    return { ret: -1, msg, data: {} as T, transportError: error };
  }

  private async post<T>(
    fileID: string,
    sheetID: string,
    body: unknown,
  ): Promise<ApiEnvelope<T>> {
    // 客户端令牌桶（5.4）
    try {
      await this.fileLimiter.acquire(fileID);
      await this.openIdLimiter.acquire(this.credentials.openId);
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        return this.envelopeFromTransportError<T>(
          mcpError("RATE_LIMITED", "触发腾讯文档频控，等待超时", "请稍后重试"),
          "触发腾讯文档频控，等待超时",
        );
      }
      throw err;
    }

    const url = this.buildUrl(fileID, sheetID);
    const payload = JSON.stringify(body);
    let lastError: McpError = mcpError("INTERNAL_ERROR", "未知错误");

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Access-Token": this.credentials.accessToken,
            "Client-Id": this.credentials.clientId,
            "Open-Id": this.credentials.openId,
          },
          body: payload,
          signal: controller.signal,
        });

        const status = response.status;
        if (status === 429 || status >= 500) {
          const message = `腾讯文档接口返回 HTTP ${status}`;
          lastError = classifyHttpStatus(status, message);
          if (attempt < this.maxRetries) {
            this.logger?.warn({ status, attempt }, "Tencent Docs API retryable status");
            await this.sleep(this.retryDelay(attempt));
            continue;
          }
          return this.envelopeFromTransportError<T>(lastError, message);
        }

        if (!response.ok) {
          const message = `腾讯文档接口返回 HTTP ${status}`;
          return this.envelopeFromTransportError<T>(
            classifyHttpStatus(status, message),
            message,
          );
        }

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          return this.envelopeFromTransportError<T>(
            mcpError("API_ERROR", "腾讯文档响应不是合法 JSON", "请检查接口地址或网络代理"),
            "腾讯文档响应不是合法 JSON",
          );
        }

        const envelope = parsed as Partial<TencentApiEnvelope<T>>;
        if (!envelope || typeof envelope.ret !== "number") {
          return this.envelopeFromTransportError<T>(
            mcpError("API_ERROR", "腾讯文档响应缺少 ret 字段"),
            "腾讯文档响应缺少 ret 字段",
          );
        }
        return {
          ret: envelope.ret,
          msg: typeof envelope.msg === "string" ? envelope.msg : "",
          data: (envelope.data ?? {}) as T,
        };
      } catch (err) {
        const aborted =
          typeof err === "object" &&
          err !== null &&
          ((err as { name?: string }).name === "AbortError" ||
            (err as { code?: string }).code === "ABORT_ERR");
        lastError = aborted
          ? mcpError("TIMEOUT", `请求腾讯文档超时（${this.timeoutMs}ms）`, "请稍后重试")
          : mcpError(
              "API_ERROR",
              `请求腾讯文档失败：${(err as Error)?.message ?? String(err)}`,
              "请检查网络或反向代理",
            );
        if (attempt < this.maxRetries) {
          this.logger?.warn(
            { err: lastError.code, attempt },
            "Tencent Docs API request failed, retrying",
          );
          await this.sleep(this.retryDelay(attempt));
          continue;
        }
        return this.envelopeFromTransportError<T>(lastError, lastError.message);
      } finally {
        clearTimeout(timer);
      }
    }

    return this.envelopeFromTransportError<T>(lastError, lastError.message);
  }

  private retryDelay(attempt: number): number {
    return this.retryDelaysMs[attempt] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? 500;
  }

  /** 官方 getRecords */
  async getRecords(
    fileID: string,
    sheetID: string,
    request: GetRecordsRequest = {},
  ): Promise<ApiEnvelope<{ getRecords: GetRecordsData }>> {
    return this.post<{ getRecords: GetRecordsData }>(fileID, sheetID, {
      getRecords: request,
    });
  }

  /** 官方 updateRecords */
  async updateRecords(
    fileID: string,
    sheetID: string,
    request: UpdateRecordsRequest,
  ): Promise<ApiEnvelope<{ updateRecords: UpdateRecordsData }>> {
    return this.post<{ updateRecords: UpdateRecordsData }>(fileID, sheetID, {
      updateRecords: request,
    });
  }

  /** 官方 addRecords */
  async addRecords(
    fileID: string,
    sheetID: string,
    request: AddRecordsRequest,
  ): Promise<ApiEnvelope<{ addRecords: AddRecordsData }>> {
    return this.post<{ addRecords: AddRecordsData }>(fileID, sheetID, {
      addRecords: request,
    });
  }

  /**
   * 内部分页扫描：offset + hasMore + next 直到结束或达到 maxRecords。
   * 传 recordIDs 时只读取这些记录（按 100 分块）。
   */
  async scanRecords(
    fileID: string,
    sheetID: string,
    options: ScanOptions = {},
  ): Promise<ScanResult> {
    const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
    const maxRecords = options.maxRecords && options.maxRecords > 0 ? options.maxRecords : Infinity;
    const records: TencentRecord[] = [];
    let scanned = 0;
    let pages = 0;
    let truncated = false;

    const requestIds = options.recordIDs?.filter((id) => Boolean(id));

    if (requestIds && requestIds.length > 0) {
      for (let start = 0; start < requestIds.length && records.length < maxRecords; start += 100) {
        if (records.length >= maxRecords) break;
        const chunk = requestIds.slice(start, start + 100);
        const resp = await this.getRecords(fileID, sheetID, {
          viewID: options.viewID,
          fieldTitles: options.fieldTitles,
          recordIDs: chunk,
          offset: 0,
          limit: Math.min(chunk.length, 100),
        });
        pages += 1;
        if (resp.transportError || resp.ret !== 0) {
          return {
            records,
            scanned,
            truncated,
            pages,
            failure: {
              ret: resp.ret,
              msg: resp.msg,
              ...(resp.transportError ? { transportError: resp.transportError } : {}),
            },
          };
        }
        const pageRecords = resp.data.getRecords?.records ?? [];
        records.push(...pageRecords);
        scanned += pageRecords.length;
      }
      if (records.length > maxRecords) {
        records.length = maxRecords;
        truncated = true;
      }
      return { records, scanned, truncated, pages };
    }

    let offset = 0;
    for (;;) {
      const resp = await this.getRecords(fileID, sheetID, {
        viewID: options.viewID,
        fieldTitles: options.fieldTitles,
        sort: options.sort,
        offset,
        limit: pageSize,
      });
      pages += 1;
      if (resp.transportError || resp.ret !== 0) {
        return {
          records,
          scanned,
          truncated,
          pages,
          failure: {
            ret: resp.ret,
            msg: resp.msg,
            ...(resp.transportError ? { transportError: resp.transportError } : {}),
          },
        };
      }

      const page = resp.data.getRecords;
      const pageRecords = page?.records ?? [];
      records.push(...pageRecords);
      scanned += pageRecords.length;

      if (records.length > maxRecords) {
        records.length = maxRecords;
        truncated = true;
        break;
      }
      if (!page?.hasMore) break;
      if (records.length >= maxRecords) {
        truncated = true;
        break;
      }

      const next = typeof page.next === "number" ? page.next : offset + pageRecords.length;
      if (next <= offset || pageRecords.length === 0) break; // 防御：避免死循环
      offset = next;
    }

    return { records, scanned, truncated, pages };
  }
}
