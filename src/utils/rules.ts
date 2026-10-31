/** 规则命中结构（需求文档 8.4 / 9.4 / 10） */

export type RuleLevel = "hard" | "soft";

export interface RuleHit {
  id: string;
  level: RuleLevel;
  field?: string;
  message: string;
}

export function hit(
  id: string,
  level: RuleLevel,
  field: string | undefined,
  message: string,
): RuleHit {
  return field === undefined ? { id, level, message } : { id, level, field, message };
}

/** 任一规则命中（hard 或 soft）都应打待确认标记 */
export function hasFailingRules(rules: RuleHit[]): boolean {
  return rules.length > 0;
}

export function ruleIds(rules: RuleHit[]): string {
  return rules.map((rule) => rule.id).join(",");
}
