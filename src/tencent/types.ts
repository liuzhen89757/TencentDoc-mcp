/**
 * 腾讯文档智能表 OpenAPI 数据类型。
 * 字段值格式见需求文档 5.3，`values` 的 key 是字段标题（fieldTitle）。
 */

export type TencentTextFragment = {
  type?: string;
  text?: string;
  link?: string;
  title?: string;
  imageID?: string;
  id?: string;
  imageUrl?: string;
  [key: string]: unknown;
};

export type TencentValue =
  | string
  | number
  | boolean
  | null
  | TencentTextFragment[]
  | TencentTextFragment;

export interface GetRecordsRequest {
  viewID?: string;
  recordIDs?: string[];
  fieldTitles?: string[];
  sort?: Array<{ fieldTitle: string; desc?: boolean }>;
  offset?: number;
  limit?: number;
}

export interface TencentRecord {
  recordID: string;
  createTime?: string;
  updateTime?: string;
  values: Record<string, TencentValue>;
}

export interface GetRecordsData {
  hasMore: boolean;
  next: number;
  total: number;
  records: TencentRecord[];
}

export interface UpdateRecordEntry {
  recordID: string;
  values: Record<string, TencentValue>;
}

export interface UpdateRecordsRequest {
  records: UpdateRecordEntry[];
}

export interface UpdateRecordsData {
  records: UpdateRecordEntry[];
}

export interface AddRecordEntry {
  values: Record<string, TencentValue>;
}

export interface AddRecordsRequest {
  records: AddRecordEntry[];
}

export interface AddRecordsData {
  records: UpdateRecordEntry[];
}

/** 官方统一响应外层 */
export interface TencentApiEnvelope<T> {
  ret: number;
  msg: string;
  data: T;
}
