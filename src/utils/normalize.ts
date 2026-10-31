/** 枚举/别名归一化（需求文档 8.4 / 9.4） */
import { normalizeAliasKey } from "../config.js";

export const RESULT_ENUM = ["通过", "不通过", "待定"] as const;
export type ResultEnum = (typeof RESULT_ENUM)[number];

/** 面试结果归一化；无法识别返回 undefined */
export function normalizeResult(
  raw: string | undefined,
  aliases: Record<string, string>,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const mapped = aliases[normalizeAliasKey(trimmed)];
  if (mapped !== undefined) return mapped;
  return (RESULT_ENUM as readonly string[]).includes(trimmed) ? trimmed : undefined;
}

/** 面试阶段归一化；allowed 为空表示不校验枚举 */
export function normalizeStage(
  raw: string | undefined,
  aliases: Record<string, string>,
  allowed: string[],
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const mapped = aliases[normalizeAliasKey(trimmed)] ?? trimmed;
  if (allowed.length > 0 && !allowed.some((stage) => stage.trim() === mapped)) {
    return undefined;
  }
  return mapped;
}
