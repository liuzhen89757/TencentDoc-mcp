# 验收清单（对应需求文档 §13）

> 验证命令：`npm test`（119 个测试，不访问真实腾讯文档 API）、`npm run typecheck`、`npm run build`、`npm run smoke`。
> 测试环境：Node 24 / vitest 3；所有腾讯文档 API 均使用 mock 客户端。

| # | 验收场景 | 结论 | 证据（测试/实现） |
|---|----------|------|-------------------|
| 1 | 传推荐表 sheetID、不传 candidate_id 查询 | ✅ | `tests/query-records.test.ts` 模式 A 用例；`tests/integration.test.ts` 走真实 handler，断言只查该 sheetID、`mcp.mode="recommend"` |
| 2 | 传安排表 sheetID、传存在 candidate_id，只返回该候选人 | ✅ | `tests/query-records.test.ts` 模式 B 过滤用例（混入其他候选人） |
| 3 | 同候选 3 条安排 → 1 条主记录 + 3 个 allRecordIDs + duplicateCount=3 | ✅ | `tests/query-records.test.ts` 去重用例；`tests/integration.test.ts` 2 条变体 |
| 4 | 主记录优先级：是否最新 → 面试日期 → createTime | ✅ | `tests/query-records.test.ts` 三个优先级用例；`tests/utils.test.ts` dedup 单测 |
| 5 | 不存在的 candidate_id → ret=0、total=0、records=[]、warning 提示约面 | ✅ | `tests/query-records.test.ts` 无记录用例 |
| 6 | 记录超过 100 条自动翻页 | ✅ | `tests/client.test.ts` `scanRecords` 翻页用例（hasMore/next） |
| 7 | 扫描超过 max_records → truncated=true | ✅ | `tests/client.test.ts` 截断用例；`tests/query-records.test.ts` truncated 透传 |
| 8 | 更新 confidence=0.9、规则全过：只写安排表两字段，status=updated | ✅ | `tests/update-interview-record.test.ts` 正常更新；`tests/integration.test.ts` 真实 handler 断言 values 键 |
| 9 | 更新 confidence=0.6：待确认说明非空，status=updated_pending_confirmation | ✅ | `tests/update-interview-record.test.ts` 低置信度用例 |
| 10 | 「过」归一化；无法归一 → 移除字段 + 打标 | ✅ | `tests/update-interview-record.test.ts` 归一化/无法归一用例 |
| 11 | recordID 不存在 → 透传官方 ret、status=error、不写入 | ✅ | `tests/update-interview-record.test.ts` 官方错误透传用例（H03） |
| 12 | 更新 values 含 面试阶段/面试老师/面试日期 → INVALID_ARGUMENT、不写入 | ✅ | `tests/update-interview-record.test.ts` 验收 12；`tests/integration.test.ts` 越界字段用例 |
| 13 | 更新 values 使用官方格式原样透传 | ✅ | `tests/update-interview-record.test.ts` 官方格式用例 |
| 14 | 新增正常：只写五个业务字段、推荐表无写请求、status=created | ✅ | `tests/add-interview-record.test.ts` 正常新增；`tests/integration.test.ts` 断言写入键集合 |
| 15 | 同候选人同阶段同日重复 → 不新增、返回已有记录、status=duplicate | ✅ | `tests/add-interview-record.test.ts` 重复约面用例 |
| 16 | 候选人不存在：allow_orphan=true 写入+打标；false → CANDIDATE_NOT_FOUND | ✅ | `tests/add-interview-record.test.ts` 孤儿策略用例 |
| 17 | 新增低置信度 → 写入 + 打标，status=created_pending_confirmation | ✅ | `tests/add-interview-record.test.ts` 低置信度用例 |
| 18 | 缺 面试老师 → 仍新增其余字段 + 打标 | ✅ | `tests/add-interview-record.test.ts` 缺字段用例 |
| 19 | 新增 values 含 是否通过/面试评价 → INVALID_ARGUMENT、不写入 | ✅ | `tests/add-interview-record.test.ts` 白名单用例 |
| 20 | 日期非法 → 仍创建其余字段、日期留空、打标 | ✅ | `tests/add-interview-record.test.ts` 非法日期用例 |
| 21 | 更新/新增时推荐表字段不变 | ✅ | 两个工具只调用 `scanRecords` 读推荐表；测试断言 `updateRecords`/`addRecords` 仅作用于安排表 |
| 22 | Token 过期 → 透传 ret（如 37019）、AUTH_FAILED | ✅ | `tests/query-records.test.ts`、`tests/update-interview-record.test.ts`、`tests/add-interview-record.test.ts` 均有 37019 用例 |
| 23 | 触发频控 → 退避重试；仍失败 RATE_LIMITED | ✅ | `tests/client.test.ts` 429 重试用例；`src/tencent/client.ts` |
| 24 | dry_run=true → 不写表、status=dry_run、返回将写入 values | ✅ | 更新/新增工具的 dry_run 用例 |
| 25 | 列名与配置不一致 → 透传官方 ret/msg、API_ERROR、日志可定位 | ✅ | `src/tencent/errors.ts` 统一映射；工具透传官方 ret/msg；日志含 `request_id` |
| 26 | 接口对齐：入参用 getRecords/updateRecords/addRecords，出参含 ret/msg/data，业务只在顶层与 mcp | ✅ | `tests/integration.test.ts` tools/list + 真实工具调用；`tests/server.test.ts` |
| 27 | 查询模式 B 传 offset/limit：工具文档说明不生效、结果完整 | ✅ | `query_records` 的 description 明确说明；`tests/query-records.test.ts` 模式 B 忽略 offset 用例 |
| 28 | 任一工具缺 fileID/sheetID → ret=-1、INVALID_ARGUMENT、不调用官方接口 | ✅ | 三个工具测试均有缺参用例；`tests/integration.test.ts` CONFIG_MISSING 全链路 |

## 非功能验收（§12）

| 项 | 结论 | 说明 |
|----|------|------|
| 性能 | ✅（设计） | 单候选扫描 ≤1000 条约 10 次请求；受 `MAX_SCAN_RECORDS` 限制 |
| 并发 | ✅ | 新增按 `candidate_id` 进程内互斥（`src/utils/mutex.ts` + 单测） |
| 幂等 | ✅ | 更新幂等；新增重复检测 |
| 可用性 | ✅ | `GET /healthz` 200；SIGINT/SIGTERM 优雅停机（10s 强制退出） |
| 安全 | ✅ | 密钥仅环境变量；`/mcp` 支持 Bearer（常量时间比较）；Docker 非 root |
| 隐私 | ✅ | 日志脱敏；面评只记录长度/哈希（`src/logger.ts`） |
| 可观测 | ✅ | 每次工具调用 `request_id`、耗时、`isError` |
| 限流 | ✅ | fileID 120/min、openID 250/min；429/5xx/网络错误重试 |
| 兼容 | ✅ | Node 20+（CI 使用 Node 24 验证）；Docker 镜像 linux/amd64 多阶段构建 |

## 与需求文档的已知偏差（需业务确认）

1. **A12 规则**：`create_anyway` 命中重复时使用自定义软规则 ID `A12`（需求 §9.4 未定义），用于触发待确认标记。
2. **S03 未实现**：更新工具不访问推荐表，无法获取其他候选人姓名；按需求「MVP 可关闭」处理，代码注释说明。
3. **无推荐表 ID 且 `allow_orphan=false`**：按需求 §6.2 返回 `CONFIG_MISSING`（与 §9.3「缺失即跳过」存在张力，取 §6.2 更严格语义）。
4. **`sanitized` 语义**：新增工具定义为「存在将写入/已写入记录」；更新工具在写/清空待确认列时恒为 true，与需求示例一致。
5. **A11 批量**：只与表中已有记录比较，不比较同一请求批次内的其他输入记录。
6. **真实腾讯文档联调**：本次全部测试使用 mock；上线前需用真实 `ACCESS_TOKEN` / 表 ID 做一次联调，确认枚举文本、字段类型与「待确认说明」列。
7. **企微传输协议**：同时支持 Streamable HTTP `/mcp` 与 SSE `/sse` + `/messages`（见 `tests/sse.test.ts`）。实测 cloudflared 快速隧道只支持 Streamable HTTP，会缓冲 SSE 长连接；SSE 需在正式 HTTPS 反向代理（关闭 `proxy_buffering`）下联调。若客户端不支持自定义请求头，可用 `?token=<MCP_AUTH_TOKEN>`；`/messages` 以 `sessionId` 作为会话凭据。
8. **`confidence` 改为必填**：需求 §10.1 规定缺失/非法按 0 处理并打标；当前实现要求调用方必传 0–1 的数字，缺失/非数字/越界返回错误且不写入。语义为「本次变动无需 HR 人工确认的程度」（1=信息完整可直接落库，越低越需要 HR 复核）；低置信度（合法但低于阈值）仍写入并打标。
