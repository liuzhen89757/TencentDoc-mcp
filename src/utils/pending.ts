/**
 * 待确认说明文本（需求文档 8.6 / 10.3）。
 * 示例：[MCP待确认] confidence=0.62 (<0.80); rules=S01,H04; detail=...; at=2026-10-30T14:05:00+08:00
 */
import { toShanghaiIso } from "./date.js";
import type { RuleHit } from "./rules.js";
import { truncateText } from "./values.js";

export interface PendingTextInput {
  confidence: number;
  threshold: number;
  rules: RuleHit[];
  /** 额外原因；缺省时使用规则 message 拼接 */
  detail?: string;
  nowMs?: number;
  maxLength?: number;
}

/** 去掉换行/分号等会破坏单行标记的字符 */
function sanitizeDetail(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/;/g, "，").trim();
}

export function buildPendingText(input: PendingTextInput): string {
  const { confidence, threshold, rules } = input;
  const parts: string[] = [
    `[MCP待确认] confidence=${confidence.toFixed(2)} (<${threshold.toFixed(2)})`,
  ];

  const ids = rules.map((rule) => rule.id).join(",");
  if (ids) parts.push(`rules=${ids}`);

  const detail =
    input.detail && input.detail.trim() !== ""
      ? input.detail
      : rules.map((rule) => rule.message).join("；");
  if (detail.trim() !== "") parts.push(`detail=${sanitizeDetail(detail)}`);

  parts.push(`at=${toShanghaiIso(input.nowMs ?? Date.now())}`);

  const text = parts.join("; ");
  return truncateText(text, input.maxLength ?? 500).text;
}

/** 由 MCP 管理的字段名集合（调用方传入会被覆盖） */
export function isPendingField(field: string, pendingColumn: string): boolean {
  return field === pendingColumn;
}
