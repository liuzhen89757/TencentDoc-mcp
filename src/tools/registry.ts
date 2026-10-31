/** 工具注册表：server.ts 从这里读取全部工具（由主 agent 集成维护） */
import type { ToolModule } from "./types.js";
import { addInterviewRecordTool } from "./add-interview-record.js";
import { queryRecordsTool } from "./query-records.js";
import { updateInterviewRecordTool } from "./update-interview-record.js";

export const TOOL_MODULES: ToolModule[] = [
  queryRecordsTool,
  updateInterviewRecordTool,
  addInterviewRecordTool,
];
