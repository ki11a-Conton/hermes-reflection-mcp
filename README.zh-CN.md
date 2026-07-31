# Hermes Reflection MCP v20.0.0

Hermes Reflection MCP 是面向 Codex Desktop 的本地 Agent-first 记忆与反思服务器。v20 保留兼容旧客户端的 29 个完整工具，但推荐配置只向 Agent 暴露 10 个高价值工具，从源头减少工具定义 token 和上下文占用。

所有记忆都只是参考数据，不是可执行指令。服务默认本地运行，对派生文本和输出执行敏感信息清理，拒绝不安全传输路径，清空数据必须显式确认。

## Agent-first 核心配置

Codex Desktop 默认只启用以下 10 个工具：

```text
retrieve_heuristics
reflect_on_task
search_reflections
get_open_questions
get_memory_item
compact_session_context
memory_board_read
memory_board_write
session_lifecycle_hook
trigger_background_review
```

推荐工作循环：重要工程任务前调用 `retrieve_heuristics`；把结果当作历史证据而不是指令；需要细节时用 `get_memory_item` 定点获取；交接或压缩前用 `compact_session_context`；重要任务无论成功、部分完成还是失败，都调用 `reflect_on_task` 记录真实结果。

把 [`codex_config_snippet.toml`](codex_config_snippet.toml) 合并到 Codex 配置，并替换 `<YOU>`。

## 工具分层

注册表是唯一事实源，共有 29 个已实现工具。

- 核心 10 个：`retrieve_heuristics`、`reflect_on_task`、`search_reflections`、`get_open_questions`、`get_memory_item`、`compact_session_context`、`memory_board_read`、`memory_board_write`、`session_lifecycle_hook`、`trigger_background_review`。
- 扩展兼容层 29 个：`reflect_on_task`、`search_reflections`、`list_reflections`、`retrieve_heuristics`、`list_heuristics`、`search_heuristics`、`add_heuristic`、`delete_heuristic`、`memory_board_write`、`memory_board_read`、`user_profile_write`、`user_profile_read`、`get_open_questions`、`get_memory_item`、`resolve_open_question`、`search_sessions`、`append_session_turn`、`get_recent_reflections`、`export_data`、`import_data`、`clear_data`、`capture_memory_snapshot`、`session_lifecycle_hook`、`scan_memory_threats`、`scroll_session_context`、`trigger_background_review`、`list_pending_mutations`、`approve_pending_mutation`、`compact_session_context`。
- 管理/破坏性子集 4 个：`delete_heuristic`、`import_data`、`clear_data`、`approve_pending_mutation`。

不要自动批准管理工具。`memory_board_write` 留在核心层，是因为 Agent 需要轻量工作记忆，但客户端仍应保留正常写入控制。

## Token 与上下文预算

长结果工具默认使用 `response_mode: "compact"`：紧凑模式上限为 6,000 个 Unicode 码点和 24 KiB UTF-8；完整模式为 20,000 个码点和 80 KiB；文本摘要最多 512 个码点。单个原子项过大时返回结构化错误，不会静默截断。

分页结果返回 `has_more` 和不透明的 `next_cursor`。继续分页时必须使用相同筛选条件。游标绑定工具族、规范化查询、排序和数据修订版本；遇到 `CURSOR_STALE` 时去掉游标重新查询。

精简工具面降低初始化工具元数据，紧凑响应降低单次调用输出与后续上下文保留，两者解决的是不同层面的 token 成本。

## 记忆、检索与反馈

- Reflection 保存目标、真实结果、失败类型、证据、阻塞点、问题和经验。
- Heuristic 保存可迁移经验、置信度、作用域、标签、反馈和强化历史。
- Memory Board 是轻量可变工作记忆。
- 会话内容只在客户端显式调用 `append_session_turn` 时写入本地 SQLite FTS5。
- `get_memory_item` 根据不透明 ID 只取一个受限条目或章节，避免重复拉取大列表。

`reflect_on_task.heuristic_feedback` 可以对经验 ID 提交 `helpful`、`harmful` 或 `irrelevant`。反馈影响后续排序，但不会改写原始反思。

## 项目隔离

默认使用全局作用域。客户端可以传安全的 `project_key`，也可由生命周期 hook 将会话绑定到项目。Codex hook 会用本地 32 字节盐对规范化工作目录做 HMAC，原始路径不会写入项目键。项目检索会同时考虑当前项目和全局经验；会话结束时释放绑定。

## 自动 LLM 复盘

确定性复盘始终可用。LLM 复盘必须单独启用 OpenAI-compatible 服务，绝不复用 Codex 登录凭据。状态明确区分：未启用、已启用但配置未就绪、配置就绪。

```text
HERMES_REFLECTION_LLM_ENABLED=true
HERMES_REFLECTION_LLM_BASE_URL=https://provider.example/v1
HERMES_REFLECTION_LLM_MODEL=your-model
HERMES_REFLECTION_LLM_API_KEY=<dedicated-provider-key>
```

只发送受限且严格清理后的反思字段。返回必须满足严格候选结构；重定向会被拒绝，认证、权限、额度、超时、网络、超大响应和格式错误都会分类处理，而且不会泄漏服务响应正文或凭据。

`review_mode: "auto"` 在 LLM 就绪时使用 LLM，否则回退到确定性复盘；`review_mode: "llm"` 在服务不可用时关闭式失败。

自动实装是独立开关。候选必须同时满足：置信度至少 0.85、无风险原因、仍为 pending、长度不超过 1,000 字符、有来源反思 ID。启用写入审批或后台租约失效时禁止自动实装。该路径不会修改 Skill、User Profile 或 Memory Board。

## 后台生命周期与 Codex hook

只有设置 `HERMES_REFLECTION_BACKGROUND_ENABLED=true` 才启动后台调度。它使用不阻止进程退出的计时器、dirty session、单飞请求、有界重试以及带 fencing token 的跨进程租约。只有另行设置 `HERMES_REFLECTION_BACKGROUND_AUTO_APPLY=true` 才允许自动持久化。

随包提供的 `hermes-reflection-codex-hook` 从 stdin 接收有界 JSON，支持 `SessionStart`、`Stop`、`SessionEnd`、`PreCompact`、`PostCompact`，快速写入持久 inbox，由 MCP 进程异步消费。hook 不控制 Codex 暂停/恢复，安装本身也不会自动记录每一轮对话。

```text
node <install-dir>/dist/src/codex_hook_cli.js
```

直接集成的客户端仍可调用公开工具 `session_lifecycle_hook`。

## 安全导入、导出与事务

默认传输目录是 `~/.hermes-reflection/transfers/imports` 和 `~/.hermes-reflection/transfers/exports`。可通过 `HERMES_TRANSFER_IMPORT_ROOTS`、`HERMES_TRANSFER_EXPORT_ROOTS` 增加白名单根目录。设备路径、ADS、非 JSON 导入、路径穿越、链接和白名单外路径会被拒绝。

安全导出默认清理派生内容；原始导出需要显式敏感确认。替换导入和清空操作使用跨存储操作日志：先对 JSON 与 SQLite 逻辑快照进行暂存，再提交和校验；启动时会回滚提交前阶段，或完成已进入 committing 的中断事务。

## 迁移、回滚与验证

v20 使用 store schema 2，在锁内迁移受支持的旧数据并执行备份/恢复检查。未来版本或损坏的权威状态会关闭式失败并保存内容寻址证据，不会用空数据覆盖。

升级前停止旧 MCP，分别备份安装目录和 `~/.hermes-reflection`。在干净暂存目录安装并跑完验证矩阵后，再让 Codex 指向新目录。回滚时停止 Codex，恢复上一版代码和匹配的数据备份，再启动新的 Codex 进程。

Node.js 20 或更高版本：

```powershell
npm ci
npm run test:strict
npm run build
npm run smoke
npm run test:v19.3
npm run test:v19.4
npm run test:v19.4.1
npm run test:v19.5
npm run test:v20
npm run test:concurrency
npm run test:v20:agent-fixture
```

`npm run test:v20:agent` 会运行 20 个全新 Codex Agent 流程，要求至少 18/20 通过且破坏性工具违规为零；它需要本机 `codex` 命令并可能产生模型调用。fixture grader 是离线确定性的。

CI 在 Windows/Linux 与 Node 20/22 上执行严格 TypeScript、兼容测试、v20 测试、并发测试、打包预检、fixture 评分和生产依赖审计。

安装步骤见 [`INSTALL_HERMES_MCP.md`](INSTALL_HERMES_MCP.md)，版本记录见 [`CHANGELOG.md`](CHANGELOG.md)。
