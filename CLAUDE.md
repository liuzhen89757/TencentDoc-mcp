# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

面向企业微信招聘机器人的 MCP Server（Node.js + TypeScript，ESM）。把腾讯文档智能表的「候选人推荐表」与「面试安排表」暴露为三个 MCP 工具：`query_records`、`update_interview_record`、`add_interview_record`。需求以 `docs/腾讯文档智能表MCP-需求文档.md` 为准，交付拆分见 `docs/stories.md`，验收证据见 `docs/acceptance.md`。

## 常用命令

```bash
npm install
cp .env.example .env        # 至少填 ACCESS_TOKEN / CLIENT_ID / OPEN_ID
npm run dev                 # tsx watch src/index.ts
npm test                    # vitest run（全部使用 mock，不访问真实腾讯文档）
npm run typecheck           # tsc --noEmit（含 tests）
npm run build               # tsconfig.build.json → dist/（只编译 src）
npm start                   # node dist/index.js
npm run smoke               # 需先 build；启动 dist 验证 /healthz、initialize、tools/list、tools/call、SSE
```

单测：`npx vitest run tests/query-records.test.ts`；按用例名：`npx vitest run -t "重复约面"`。无 lint 脚本，类型检查即质量门。

## 架构

请求链路：`src/index.ts`（加载配置 → 构造 `TencentDocsClient` → `createHttpApp` → 监听 → 10s 优雅停机）→ `src/server.ts` → `src/tools/registry.ts` 中的 `TOOL_MODULES` → 各工具 handler → `TencentDocsClient`。

- **传输层**（`src/server.ts`）：Express 5，两种传输共享同一套工具实现。
  - `POST /mcp`：Streamable HTTP 无状态模式，每个请求新建 `McpServer` + `StreamableHTTPServerTransport`，响应结束即关闭；`GET/DELETE /mcp` 固定 405。
  - `GET /sse` + `POST /messages?sessionId=`：有状态 SSE，会话存在进程内 `sseSessions` Map，只适合单实例/粘性会话。
  - `MCP_AUTH_TOKEN` 非空时校验 Bearer，兼容 `?token=` / `?access_token=`；常量时间比较。`GET /healthz` 供健康检查。
- **工具契约**（`src/tools/types.ts`）：每个工具是一个 `ToolModule`（name/title/description/Zod 输入 shape/annotations/handler）。新增工具 = 新建模块 + 加入 `registry.ts`；`server.ts` 统一注入 `ToolContext` 并生成 `requestId` 打日志。
- **腾讯文档客户端**（`src/tencent/client.ts`）：`getRecords`/`updateRecords`/`addRecords` 共用同一 URL，靠请求体根键区分；统一处理鉴权头、10s 超时、429/5xx/网络错误退避重试、按 fileID/openID 滑动窗口限流。`scanRecords` 是模式 B、候选人校验、重复检测的共用分页引擎。
- **配置**（`src/config.ts`）：全部来自环境变量（见 `.env.example`）。凭证缺失时服务照常启动，由工具返回 `CONFIG_MISSING`。`FIELD_*` 必须与智能表实际列标题完全一致（含空格/大小写）。
- **工具函数**（`src/utils/`）：`values.ts` 官方字段值读写、`date.ts` Asia/Shanghai 时间处理、`dedup.ts` 主记录选取、`normalize.ts` 枚举/别名归一化、`pending.ts` 待确认说明文本、`rules.ts` 规则结构、`result.ts` 统一响应、`mutex.ts` 按 key 进程内互斥。

## 必须遵守的约定

1. **响应结构**：成功与业务错误都用 `{ ret, msg, data, mcp }`。待确认、重复、部分成功属于业务结果 → `ret=0` + `mcp.status`，`isError` 为 false；只有协议/基础设施失败（`CONFIG_MISSING`/`AUTH_FAILED`/`API_ERROR`/`INTERNAL_ERROR`，见 `tencent/errors.ts:isProtocolError`）才 `isError=true`。handler 抛异常由 `server.ts` 兜底为 `INTERNAL_ERROR`，禁止向客户端暴露堆栈。
2. **只写面试安排表**：推荐表及其公式列（`是否最新`、推荐表的 `面试阶段`/`是否通过`）永远只读。更新/新增都只对入参 `sheetID` 调写接口。
3. **字段白名单**：更新仅允许 `是否通过`、`面试评价`；新增仅允许 `candidate_id`/`姓名`/`面试日期`/`面试阶段`/`面试老师`。`待确认说明` 由 MCP 管理，调用方传入会被覆盖/丢弃。出现其他字段立即 `INVALID_ARGUMENT`，且在任何官方调用之前拒绝。
4. **值格式必须是官方结构**：文本 `[{type:"text",text}]`、单选 `[{text}]`、空值 `[]`、日期为毫秒时间戳字符串；不接受纯字符串替代。
5. **`confidence` 必填且取值 0–1**，语义是「本次变动无需 HR 人工确认的程度」：1=信息完整、可直接落库；越低越需要 HR 复核（例如表中缺少面试日期却要更新面评），低值会写待确认说明。缺失/非数字/越界返回错误，不写入。它只影响待确认标记，不影响是否写入。
6. **中文 `fieldTitles` 过滤不可靠**：模式 B 查询、推荐表校验、重复检测都刻意不传 `fieldTitles`，全量扫描后在本地提取；模式 B 还忽略 `offset`/`limit`（`limit` 仅作页大小参考）。修改扫描逻辑时不要把该行为“修正”掉。
7. **并发**：`add_interview_record` 用 `acquireKeyLocks(candidateIds)` 把「重复检测 + 写入」按 `candidate_id` 串行化，必须在 `finally` 释放。
8. **规则 ID**：硬规则 H0x、软规则 S0x/A0x 贯穿工具实现、`mcp.rules`、待确认说明与验收清单；改动规则时同步更新 `docs/acceptance.md` 中相关条目。
9. **ESM + NodeNext**：源码中相对导入一律带 `.js` 后缀（如 `from "./config.js"`），新增文件沿用此约定。

## 测试

vitest，默认包含 `tests/**/*.test.ts`，超时 15s。所有腾讯文档 API 使用 mock：`tests/helpers/config.ts` 的 `makeTestConfig()`、`tests/helpers/tencent.ts` 的 `createMockClient()`/`makeRecord()`/`getRecordsResponse()`。工具测试直接调 handler；`tests/integration.test.ts` 用真实 registry 走完整 Streamable HTTP 链路；`tests/sse.test.ts` 覆盖 SSE。测试数据涉及日期时使用上海时区并避开 A09/A10 软规则（见 `integration.test.ts` 的 `nextWorkingDayAt10()`），否则会意外产生待确认标记。

## 部署

Docker 多阶段构建（node:22-alpine，非 root），`CMD node dist/index.js`，健康检查走 `/healthz`；`docker compose up -d --build`。企业微信要求公网 HTTPS，公网部署必须设置 `MCP_AUTH_TOKEN`；反向代理需透传 `Authorization`/`Accept`/`Content-Type`，SSE 必须关闭缓冲并放大读超时（详见 README「Docker 部署」「没有公网域名时怎么办」）。

## 已知待确认项

需求文档 §15.1 的枚举文本、字段类型、`待确认说明` 列可用性等仍需业务方确认。上线前需用真实凭证与表 ID 做一次联调；当前测试全部基于 mock，不能证明真实表结构兼容。README「已知待确认项」与 `docs/acceptance.md`「与需求文档的已知偏差」列出了实现层的取舍。
