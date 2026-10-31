/**
 * 日期处理：统一按 Asia/Shanghai（UTC+8，无夏令时）解析与格式化。
 * 支持传入毫秒时间戳字符串、秒级时间戳、ISO 8601、中文日期。
 */

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const MS_PER_SECOND = 1000;

function numericToMs(raw: string): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // 10 位按秒处理，13 位按毫秒处理
  return n < 1e11 ? Math.round(n * MS_PER_SECOND) : Math.round(n);
}

function isValidParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/**
 * 解析日期为毫秒时间戳。
 * - 纯数字：10 位按秒、13 位按毫秒
 * - 带时区的 ISO 8601：按原时区解析
 * - 不带时区的 ISO / 中文日期：按 Asia/Shanghai 解析
 */
export function parseDateMs(input: unknown): number | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return undefined;
    return input < 1e11 ? Math.round(input * MS_PER_SECOND) : Math.round(input);
  }
  if (typeof input !== "string") return undefined;

  const raw = input.trim();
  if (raw === "") return undefined;

  const numeric = numericToMs(raw);
  if (numeric !== undefined) return numeric;

  // 显式时区的 ISO 8601（Z 或 ±HH:MM / ±HHMM）
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    return undefined;
  }

  // 2026-11-07 / 2026/11/07 / 2026年11月7日 [14:00[:00]]（按上海时间）
  const match = raw.match(
    /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[T\s]+(\d{1,2})[:：时](\d{1,2})(?:[:：分](\d{1,2})(?:\.\d+)?|\.\d+|分)?)?$/,
  );
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (!isValidParts(year, month, day, hour, minute, second)) return undefined;
  return Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MS;
}

export interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO 星期：1=周一 … 7=周日 */
  weekday: number;
}

export function shanghaiParts(ms: number): ShanghaiParts {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const day = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: day === 0 ? 7 : day,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 2026-10-30T14:05:00+08:00 */
export function toShanghaiIso(ms: number): string {
  const p = shanghaiParts(ms);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}+08:00`;
}

/** 2026-10-30 */
export function toShanghaiDate(ms: number): string {
  const p = shanghaiParts(ms);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 2026-10-30 14:05 */
export function toShanghaiDateTime(ms: number): string {
  const p = shanghaiParts(ms);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 上海时区当天 00:00:00 的毫秒时间戳 */
export function startOfShanghaiDay(ms: number): number {
  const p = shanghaiParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day) - SHANGHAI_OFFSET_MS;
}

export function sameShanghaiDay(a: number, b: number): boolean {
  return startOfShanghaiDay(a) === startOfShanghaiDay(b);
}

/** 两个时间点相差的小时数（绝对值） */
export function hoursBetween(a: number, b: number): number {
  return Math.abs(a - b) / 3_600_000;
}

/** ISO 星期是否为工作日 */
export function isWorkingDay(ms: number, workingDays: number[]): boolean {
  return workingDays.includes(shanghaiParts(ms).weekday);
}

/** 是否处于工作时间（start 含、end 不含） */
export function isWithinWorkingHours(
  ms: number,
  hours: { start: number; end: number },
): boolean {
  const { hour, minute } = shanghaiParts(ms);
  const value = hour + minute / 60;
  if (hours.start <= hours.end) {
    return value >= hours.start && value < hours.end;
  }
  // 跨午夜
  return value >= hours.start || value < hours.end;
}

/** A09：不早于今天，且不超过今天 + 180 天 */
export function isReasonableInterviewDate(
  ms: number,
  nowMs: number,
  maxDays = 180,
): boolean {
  const todayStart = startOfShanghaiDay(nowMs);
  return ms >= todayStart && ms <= todayStart + maxDays * DAY_MS;
}
