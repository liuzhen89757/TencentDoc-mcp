# 腾讯文档智能表 MCP — 故事拆分与交付计划

> 依据：`docs/腾讯文档智能表MCP-需求文档.md` v0.1
> 拆分原则：每个故事可独立验收、文件边界清晰、可并行开发。

## 1. 拆分总览

| 故事 | 名称 | 依赖 | 主要交付物 | 对应验收 |
|------|------|------|-----------|----------|
| S0 | 工程底座 | — | 配置、OpenAPI 客户端、值/日期/去重/规则工具、工具契约、registry | 5.4、6、11、12 |
| S1 | 查询记录 `query_records` | S0 | `src/tools/query-records.ts` | 1–7、27、28 |
| S2 | 更新面试记录 `update_interview_record` | S0 | `src/tools/update-interview-record.ts` | 8–13、21、24–26、28 |
| S3 | 新增面试安排 `add_interview_record` | S0 | `src/tools/add-interview-record.ts` | 14–21、24–26、28 |
| S4 | HTTP 接入与部署 | S0 | `src/server.ts`、`src/index.ts`、Docker、README | 12、15.1-5 |
| S5 | 集成与验收 | S1–S4 | `src/tools/registry.ts`、端到端测试、验收清单 | 全部 |

## 2. 故事详情

### S0 工程底座（1 人日）

**目标**：提供所有工具共用的基础设施。

**任务**

1. Node 20+ / TypeScript（ESM、NodeNext）+ vitest 工程脚手架。
2. 配置模块：环境变量解析、校验、默认值（§6.1、§6.3），凭证缺失时服务可启动。
3. 腾讯文档客户端：
   - 三接口（`getRecords` / `updateRecords` / `addRecords`）共用 URL，请求体根键区分；
   - 鉴权头 `Access-Token` / `Client-Id` / `Open-Id`；
   - 10s 超时；429/5xx/网络错误 2 次退避（500ms、1500ms）；
   - 按 fileID 120/min、openID 250/min 滑动窗口限流；
   - 分页扫描 `scanRecords`（offset + hasMore + next，`max_records` 截断）。
4. 公共工具：字段值序列化/提取、上海时区日期解析、枚举归一化、规则结构、待确认文本、去重选主、统一错误响应。
5. 工具契约 `ToolModule` 与测试夹具。

**完成标准**：底座单测通过；`tsc --noEmit` 无错误。

---

### S1 查询记录 `query_records`（0.5 人日）

**用户故事**：作为企微招聘机器人，我需要按候选人查询推荐表/面试安排表，以便定位 `candidate_id` 与最新一条面试记录。

**任务**

- 模式 A（不传 `candidate_id`）：官方 `getRecords` 直通，`mcp.mode="recommend"`。
- 模式 B（传 `candidate_id`）：内部翻页扫描 → 按 `candidate_id` 过滤 → 去重选主（是否最新 → 面试日期 → createTime）→ 返回主记录与全部 `recordIDs`。
- `max_records` 截断提示；空结果提示可约面。
- 工具描述写明模式 B 忽略 `offset` / `limit`。

**完成标准**：验收 1–7、27、28 的自动化测试通过。

---

### S2 更新面试记录 `update_interview_record`（1 人日）

**用户故事**：作为机器人，我需要把面评与面试结果写回面试安排表，并在低置信度或规则失败时打待确认标记。

**任务**

- 白名单：仅 `是否通过`、`面试评价`（`待确认说明` 由 MCP 管理）。
- 硬规则 H01–H05、软规则 S01/S02/S04。
- `confidence` 只影响标记；`dry_run`；`mark_pending`。
- 官方 `updateRecords` 透传，`mcp.status` 表达 `updated` / `updated_pending_confirmation` / `dry_run` / `error`。
- 推荐表零写入。

**完成标准**：验收 8–13、21、24–26、28 的自动化测试通过。

---

### S3 新增面试安排 `add_interview_record`（0.5 人日）

**用户故事**：作为机器人，我需要在面试安排表新增约面记录，并做重复检测与候选人校验。

**任务**

- 白名单：`candidate_id`、`姓名`、`面试日期`、`面试阶段`、`面试老师`。
- 归一化：日期毫秒时间戳、阶段枚举与别名。
- 推荐表只读校验（`recommendSheetID` / `RECOMMEND_SHEET_ID`），姓名以推荐表为准，孤儿策略 `allow_orphan`。
- 重复检测（同候选人 + 同阶段 + 同日/2 小时内），`return_existing` / `create_anyway`。
- 软规则 A07–A11（置信度、姓名、日期合理性、工作时间、同日其他轮次）。
- 进程内按 `candidate_id` 互斥锁，串行「重复检测 + 写入」，避免并发重复约面。
- `dry_run`。

**完成标准**：验收 14–21、24–26、28 的自动化测试通过。

---

### S4 HTTP 接入与部署（0.5 人日）

**用户故事**：作为企微机器人管理员，我需要一个常驻 HTTPS 服务，通过 Streamable HTTP 调用 MCP。

**任务**

- Express + MCP SDK：Streamable HTTP 无状态端点 `POST /mcp`，同时提供 SSE `GET /sse` + `POST /messages` 兼容只支持 SSE 的机器人。
- `MCP_AUTH_TOKEN` Bearer 鉴权、`GET /healthz`、优雅停机。
- 请求级日志（request_id、耗时、扫描量、写入 recordID、规则命中；不记录面评正文）。
- Dockerfile、docker-compose、`.env.example`、README。

**完成标准**：健康检查/鉴权/协议握手测试通过；镜像可构建。

---

### S5 集成与验收

**任务**

1. `registry.ts` 汇总三个工具并注册到 MCP。
2. 全量 `npm test`、`npm run typecheck`、`npm run build`。
3. 按需求 §13 的 28 条验收标准逐条核对，输出验收清单。
4. 核对非功能项：限流、重试、隐私日志、错误码、`isError` 语义。

## 3. 依赖与并行策略

```text
S0 ──┬── S1 ──┐
     ├── S2 ──┼── S5
     ├── S3 ──┤
     └── S4 ──┘
```

- S1/S2/S3/S4 在 S0 完成后可完全并行，文件互不重叠。
- S5 在四个故事完成后由主 agent 集成。

## 4. 待确认项（开发期以默认值+环境变量兜底）

见需求 §15.1，当前实现策略：

| 待确认项 | 当前策略 |
|----------|----------|
| 面试阶段/是否通过枚举文本 | `INTERVIEW_STAGES`、`RESULT_ALIASES`、`STAGE_ALIASES` 环境变量可覆盖；无法归一化时移除字段 + 打标 |
| 字段类型 | 统一按官方 JSON 值读写；成员字段本期按文本处理 |
| `待确认说明` 列 | 默认 `待确认说明`，`PENDING_COLUMN` 可改；无该列时 `MARK_PENDING=false` |
| 企微传输协议 | 提供 Streamable HTTP `/mcp`；如仅支持 SSE，可后续补 `/sse` |
| 表数据量 | `MAX_SCAN_RECORDS`（默认 1000）+ 截断提示 |
| Token 生命周期 | 静态 Token；`AUTH_FAILED` 提示重新获取 |
