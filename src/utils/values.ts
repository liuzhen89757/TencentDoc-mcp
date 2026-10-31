/** 腾讯文档字段值读写辅助（格式见需求文档 5.3） */
import type { TencentTextFragment, TencentValue } from "../tencent/types.js";

function fragmentText(fragment: unknown): string {
  if (fragment === null || fragment === undefined) return "";
  if (typeof fragment === "string") return fragment;
  if (typeof fragment === "number" || typeof fragment === "boolean") return String(fragment);
  if (typeof fragment !== "object") return "";
  const f = fragment as TencentTextFragment;
  if (typeof f.text === "string") return f.text;
  if (typeof f.title === "string") return f.title;
  if (typeof f.link === "string") return f.link;
  return "";
}

/** 文本/多段文本拼接为完整字符串 */
export function extractText(value: TencentValue | undefined | null): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(fragmentText).join("");
  return fragmentText(value);
}

/** 单选/多选取第一个片段文本 */
export function extractSelect(value: TencentValue | undefined | null): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (Array.isArray(value)) {
    for (const fragment of value) {
      if (fragment && typeof fragment === "object" && typeof fragment.text === "string") {
        return fragment.text;
      }
    }
    return undefined;
  }
  if (typeof value === "object") {
    const fragment = value as TencentTextFragment;
    return typeof fragment.text === "string" ? fragment.text : undefined;
  }
  return String(value);
}

/** 官方文本值：[{type:"text", text}] */
export function textValue(text: string): TencentTextFragment[] {
  return [{ type: "text", text }];
}

/** 官方单选值：[{text}] */
export function selectValue(text: string): TencentTextFragment[] {
  return [{ text }];
}

/** 空文本/单选值：[] */
export function emptyValue(): TencentTextFragment[] {
  return [];
}

/** 是否为空值（null/undefined/空数组/空字符串） */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0 || extractText(value).trim() === "";
  return false;
}

/** 截断文本，超出时追加省略号 */
export function truncateText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (maxLength <= 0 || text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxLength - 1)}…`, truncated: true };
}

/** 判断文本是否是「是」语义（用于 是否最新 公式列） */
export function isTruthyFlag(value: TencentValue | undefined | null): boolean {
  const text = extractText(value).trim().toLowerCase();
  return ["是", "true", "yes", "y", "1", "最新"].includes(text);
}
