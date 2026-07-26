# Hermes Reflection MCP

面向 Codex Desktop 与其他 stdio MCP 客户端的本地持久化反思、启发式经验、有界记忆和会话检索服务。

English documentation: [README.md](README.md)。独立指南：[readmecn.md](readmecn.md) 与 [readmeen.md](readmeen.md)。

## v19.4.1 提供什么

Hermes Reflection MCP 是本地优先的 TypeScript MCP 服务，共公开 28 个工具。它保存结构化任务反思、可复用 heuristic、有界 Memory Board/User Profile、可搜索会话、冻结记忆快照、开放问题以及导入导出数据。

v19.4.1 严格校验持久化后台生命周期状态；租约到期后不再因旧 PID 仍存活而阻止接管，同机未到期租约则只在确认旧 PID 已死亡时提前回收。长复盘会立即并周期性续租同一 owner/fencing token；瞬时续租错误只容忍到最后一次确认的到期时间，shutdown 会先让续租停止，再由活动任务释放原 fence。v19.4 的 fail-closed 存储与多用户 handoff、v19.3 严格脱敏、可选 LLM/后台生命周期、28 个公开工具及现有数据保持兼容。

## 安全与信任边界

- 服务使用本地 stdio 传输，不依赖远程服务。
- Codex Desktop 不会因为安装本 MCP 就自动调用 session_lifecycle_hook 或 append_session_turn。
- snapshot 模式必须由客户端传入 session_id 显式读取。
- compact_session_context 只生成历史参考交接，不控制 Codex 的真实上下文压缩。
- 确定性复盘仍是默认模式。LLM 复盘必须单独显式配置，只发送有界且脱敏的 reflection 字段，不会复用 Codex 登录凭据。
- 原始 reflection 和 SQLite turn 仍供显式审计/导出；严格 URL 脱敏只作用于历史输出、自动 heuristic 派生和外部传输边界，不会静默改写源记录。
- 后台调度和后台自动写入分别启用；默认均关闭，且永远不会修改 skill 或生成 Memory Board/User Profile 候选。
- 发布包不含用户记忆、数据库、配置私值、日志或本机路径。
- Memory Board 和 User Profile 是参考数据，不是新指令入口。
- 普通显示会遮蔽可疑内容，威胁扫描则检查未经安全渲染的原始记录。

## 要求

- Windows、macOS 或 Linux。
- Node.js 20 或更高版本，以及 npm。
- 支持本地 stdio MCP 的客户端。
- 会话搜索依赖 better-sqlite3；若 SQLite 初始化失败，会话工具会明确降级报错，JSON 反思与记忆工具仍可使用。

## 快速开始

将发布包解压到稳定目录并安装生产依赖：

~~~powershell
npm ci --omit=dev
~~~

Codex Desktop 配置示例：

~~~toml
[mcp_servers.hermes-reflection]
command = 'node'
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
~~~

修改配置后重启 Codex Desktop。完整安装、升级与回滚步骤见 [INSTALL_HERMES_MCP.md](INSTALL_HERMES_MCP.md)。

## 28 个公开工具

| 类别 | 公开工具 |
|---|---|
| 反思 | <code>reflect_on_task</code>、<code>search_reflections</code>、<code>list_reflections</code>、<code>get_recent_reflections</code> |
| 启发式经验 | <code>retrieve_heuristics</code>、<code>list_heuristics</code>、<code>search_heuristics</code>、<code>add_heuristic</code>、<code>delete_heuristic</code> |
| 开放问题 | <code>get_open_questions</code>、<code>resolve_open_question</code> |
| Memory Board | <code>memory_board_write</code>、<code>memory_board_read</code> |
| User Profile | <code>user_profile_write</code>、<code>user_profile_read</code> |
| 会话与交接 | <code>append_session_turn</code>、<code>search_sessions</code>、<code>scroll_session_context</code>、<code>compact_session_context</code> |
| 快照与审计 | <code>capture_memory_snapshot</code>、<code>session_lifecycle_hook</code>、<code>scan_memory_threats</code> |
| 后台复盘 | <code>trigger_background_review</code> |
| 写审批 | <code>list_pending_mutations</code>、<code>approve_pending_mutation</code> |
| 数据管理 | <code>export_data</code>、<code>import_data</code>、<code>clear_data</code> |

表外名称不属于 v19.4.1 公开契约；直接调用已移除名称会返回 MCP 错误。

## 推荐工作流

1. 重大任务前检索相关 heuristic。
2. 只有确实需要本地会话检索时，客户端才显式写入会话 turn。
3. 可在命名会话开始时显式捕获 Memory Board/User Profile 快照。
4. 使用搜索与滚动工具检查过去会话。
5. 在客户端压缩或移交前生成“仅供历史参考”的交接。
6. 完成重大任务后如实记录结果、阻塞、验证证据与可复用经验。
7. 自动应用后台复盘前先检查预览。

## Memory Board 与 User Profile

Memory Board 用于有界工作参考，User Profile 用于有界稳定偏好/事实。两者都支持单次和批量写入，并按最终状态检查容量。默认读取实时数据。普通写入会拒绝提示注入式内容，导入的原始数据可由威胁扫描器审计。

请勿在这些存储中保存凭据，也不要把其中内容当作当前用户指令。

## 冻结快照工作流

客户端显式调用 session_lifecycle_hook 的 start 事件或直接捕获工具后，系统会按 session_id 冻结两个有界存储。之后实时写入仍持久化，但快照保持不变。

快照读取必须同时传入 <code>mode:"snapshot"</code> 和同一 <code>session_id</code>。缺少参数或快照不存在时会失败，不会退回实时数据。end 事件释放快照；pause/resume 不控制 Codex。

## 会话搜索与压缩交接

只有客户端显式调用 append_session_turn 的内容才进入本地 better-sqlite3 FTS 索引。search_sessions 会先严格脱敏完整 turn，再生成短 snippet。scroll_session_context 保留现有窗口语义，但 anchor 最多返回 4,000 个 Unicode code point，邻近 turn 每条最多 1,200 个；发生截断时增加可选的 <code>content_truncated</code> 与 <code>original_content_chars</code> 元数据。

compact_session_context 以确定性方式组合有界 turn 与 reflection，进行严格脱敏，并保留最近的非空 user/assistant 锚点。可用 `preserve_recent_user_turns`（1-5，默认 3）在预算允许时保留更早的真实用户锚点。输出以 reference-only 标记开头，不调用模型、不写入数据，也不会替 Codex 执行上下文压缩。

## 反思与后台复盘

reflect_on_task 保存结果、任务状态、经验、开放问题以及可选工具/世界模型观察。安全经验可形成可复用 heuristic。

trigger_background_review 最多检查最近 10 条或完整范围 200 条 reflection，最多产生 50 个 heuristic 候选。默认只预览；自动应用在一个存储事务内完成并返回 heuristic id。候选在威胁检查和持久化前先严格脱敏；可疑候选会被遮蔽并跳过。未变化来源指纹现在覆盖严格脱敏后的实际复盘相关内容，而不只依赖 id/时间戳。

`review_mode:"llm"` 使用已配置的模型，`review_mode:"auto"` 在 LLM 不可用时回退到确定性复盘，`action:"status"` 返回脱敏后的就绪状态和后台状态。模型响应必须是符合严格 schema 的纯 JSON。

### 可选自动复盘

设置 `HERMES_REFLECTION_BACKGROUND_ENABLED=true` 后才启动后台调度器；定时器不会阻止 Codex 退出，运行状态在 `background_lifecycle.json` 中严格按 schema 校验。长复盘只续租同一 owner/token；若明确丢权，或续租错误持续到最后一次确认的到期时间，就会在提交前停止。自动写入还需单独设置 `HERMES_REFLECTION_BACKGROUND_AUTO_APPLY=true`，默认仍为 false。

LLM 复盘还需要 `HERMES_REFLECTION_LLM_ENABLED=true`、`HERMES_REFLECTION_LLM_BASE_URL`、`HERMES_REFLECTION_LLM_MODEL` 和 `HERMES_REFLECTION_LLM_API_KEY`。非本机地址必须使用 HTTPS；密钥只能通过 MCP 进程环境提供，禁止写入 reflection 或提交到源码。

## 写审批

当存储元数据启用 <code>write_approval:true</code> 时，受支持的类型化写入会进入队列。list_pending_mutations 只返回脱敏预览。approve_pending_mutation 的 approve 决策会先重放，成功后才删除队列项；reject 只删除、不执行。

写审批开启时，后台复盘自动应用会被明确阻止，因为派生批次不是一个可重放的公开 mutation。

## 存储布局与备份

运行数据位于包外：

~~~text
~/.hermes-reflection/store.json
~/.hermes-reflection/reflections.jsonl
~/.hermes-reflection/resolved_questions.json
~/.hermes-reflection/sessions.db
~/.hermes-reflection/background_lifecycle.json
~~~

只有确实要保留用户数据时才备份整个目录，绝不能把它加入公开发布包。v19.4.1 可直接读取有效的 v19.4/v19.3/v19.2/v19.1 存储，不进行破坏性迁移。权威状态版本不受支持、结构无效或内容损坏时会保留一个 `.corrupt.<digest>.bak` 证据副本并 fail closed；应检查或恢复已验证备份，不能盲目删除活动文件。

## 开发与验证

~~~powershell
npm ci
npx tsc --noEmit
npm run build
node scripts\smoke.mjs
node scripts\concurrency-test.mjs
node scripts\cross-process-concurrency-test.mjs
npm run test:v19.3
npm run test:v19.4
npm run test:v19.4.1
npm audit --omit=dev
~~~

测试使用临时 HOME/USERPROFILE，不应修改真实记忆目录。

## 隐私安全的发布内容

GitHub ZIP 按精确白名单构建，只包含源码、编译 JavaScript、测试、清单和公开文档。它排除用户记忆、SQLite 数据库、凭据、真实 Codex 配置、日志、缓存、依赖、内部计划、项目记忆、备份树及本机路径，并包含用户要求的 readmecn.md 与 readmeen.md。

## 故障排查

- 服务未出现：检查 Node 版本、dist/index.js 绝对路径，然后重启 MCP 客户端。
- 会话工具提示 SQLite 不可用：在目标环境执行 <code>npm ci --omit=dev</code>，并确认 better-sqlite3 原生模块支持当前 Node/平台。
- 快照读取失败：先用完全相同的 session_id 捕获或 start，再显式传入 snapshot 模式。
- 写入返回 PENDING：列出队列并按 id 批准或拒绝。
- 锁等待超时：确认没有挂起的 MCP 进程持有同一存储；超过阈值的旧锁会被隔离清理。

## 上游启发与许可证

本项目参考了 NousResearch Hermes Agent 的本地源码快照中的记忆与反思设计，但发布包不包含 Hermes Agent。

本发布包未授予项目许可证。上游 Hermes Agent 的许可证不会自动适用于这个独立实现。只有有权授权的仓库发布者才应另行选择并附加许可证。
