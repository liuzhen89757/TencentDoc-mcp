/** candidate_id 过滤与多条面试记录去重（需求文档 7.3 模式 B） */
import type { TencentRecord } from "../tencent/types.js";
import { parseDateMs } from "./date.js";
import { extractText, isTruthyFlag } from "./values.js";

export function filterByCandidate(
  records: TencentRecord[],
  candidateId: string,
  candidateField: string,
): TencentRecord[] {
  const target = candidateId.trim();
  return records.filter(
    (record) => extractText(record.values?.[candidateField]).trim() === target,
  );
}

interface RankedRecord {
  record: TencentRecord;
  latest: number;
  dateMs: number;
  createMs: number;
  index: number;
}

function rankRecord(
  record: TencentRecord,
  index: number,
  dateField: string,
  isLatestField: string,
): RankedRecord {
  const dateMs = parseDateMs(record.values?.[dateField]) ?? Number.NEGATIVE_INFINITY;
  const createMs = Number(record.createTime) || 0;
  return {
    record,
    latest: isTruthyFlag(record.values?.[isLatestField]) ? 1 : 0,
    dateMs,
    createMs,
    index,
  };
}

/**
 * 主记录选择顺序：是否最新=是 → 面试日期最大 → createTime 最大。
 * 完全相同时保持原始顺序（稳定）。
 */
export function pickPrimaryRecord(
  records: TencentRecord[],
  dateField: string,
  isLatestField: string,
): TencentRecord | undefined {
  if (records.length === 0) return undefined;
  const ranked = records.map((record, index) =>
    rankRecord(record, index, dateField, isLatestField),
  );
  ranked.sort((a, b) => {
    if (a.latest !== b.latest) return b.latest - a.latest;
    if (a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
    if (a.createMs !== b.createMs) return b.createMs - a.createMs;
    return a.index - b.index;
  });
  return ranked[0]?.record;
}

/** 全部匹配记录 ID，按面试日期倒序（同日期按 createTime 倒序） */
export function sortRecordIdsByDateDesc(
  records: TencentRecord[],
  dateField: string,
): string[] {
  return records
    .map((record, index) => ({
      id: record.recordID,
      dateMs: parseDateMs(record.values?.[dateField]) ?? Number.NEGATIVE_INFINITY,
      createMs: Number(record.createTime) || 0,
      index,
    }))
    .sort((a, b) => {
      if (a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
      if (a.createMs !== b.createMs) return b.createMs - a.createMs;
      return a.index - b.index;
    })
    .map((item) => item.id);
}
