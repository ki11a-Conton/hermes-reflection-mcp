# Hermes Reflection MCP v19.3.0 中文使用指南

Hermes Reflection MCP 是一个本地 stdio MCP 服务，提供 28 个公开工具，用于持久化任务反思、heuristic、有界 Memory Board/User Profile 与可搜索会话。它不上传用户数据。

## 安装要求

- Windows、macOS 或 Linux
- Node.js 20 或更高版本
- npm
- 支持 stdio MCP 的客户端

会话检索依赖 better-sqlite3。如果该原生模块无法初始化，会话工具会明确返回不可用错误；反思、heuristic、JSON 记忆和导入导出仍可工作。

## Codex Desktop 安装

1. 将压缩包解压到一个不含用户数据的目录。
2. 在解压目录运行 <code>npm ci --omit=dev</code>。
3. 将项目放到 <code>%USERPROFILE%\.codex\mcp\hermes-reflection-mcp</code>，或在配置中使用自己的绝对路径。
4. 在 Codex 配置中添加：

~~~toml
[mcp_servers.hermes-reflection]
command = 'node'
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
~~~

5. 重启 Codex Desktop，使新 MCP 进程加载 v19.3.0。

安装本 MCP 不会让 Codex Desktop 自动调用 session_lifecycle_hook 或 append_session_turn。生命周期、快照和会话 turn 都必须由客户端显式调用。

## 验证

生产依赖安装完成后，在项目目录依次运行：

~~~powershell
node scripts\smoke.mjs
node scripts\concurrency-test.mjs
node scripts\cross-process-concurrency-test.mjs
npm run test:v19.3
~~~

预期：smoke 报告 v19.3.0 和 28 个公开工具；新版生命周期/LLM mock/停机测试与单进程、跨进程并发测试全部通过。测试使用临时用户目录，不会写入真实 <code>~/.hermes-reflection</code>。

如需修改源码，再安装开发依赖并执行：

~~~powershell
npm ci
npx tsc --noEmit
npm run build
~~~

## 推荐工作流

1. 重大任务前调用 <code>retrieve_heuristics</code>。
2. 需要持久化对话检索时显式调用 <code>append_session_turn</code>。
3. 会话开始时可调用 <code>session_lifecycle_hook(event:"start")</code> 捕获冻结快照。
4. 读取冻结记忆时，向 memory_board_read 或 user_profile_read 同时传入 <code>mode:"snapshot"</code> 与同一 <code>session_id</code>；不存在的快照会报错，不会退回实时内容。
5. 压缩或交接前调用 <code>compact_session_context</code> 获取仅供历史参考的摘要。它不控制 Codex 的真实上下文窗口。
6. 任务结束后调用 <code>reflect_on_task</code>，如需复盘候选再调用 <code>trigger_background_review</code>。
7. 后台复盘默认只预览且使用确定性模式；可显式配置独立 OpenAI 兼容模型，或启用带跨进程 fencing 的后台调度器。
8. 写审批开启时，使用 <code>list_pending_mutations</code> 查看脱敏预览，再用 <code>approve_pending_mutation</code> 批准或拒绝。

## 自动 LLM 复盘与后台生命周期

两者默认关闭。LLM 模式需要单独设置 `HERMES_REFLECTION_LLM_ENABLED`、`HERMES_REFLECTION_LLM_BASE_URL`、`HERMES_REFLECTION_LLM_MODEL`、`HERMES_REFLECTION_LLM_API_KEY`。后台调度需要 `HERMES_REFLECTION_BACKGROUND_ENABLED=true`；自动写入还需单独设置 `HERMES_REFLECTION_BACKGROUND_AUTO_APPLY=true`。请只通过进程环境提供专用密钥，不要把密钥写入文档或反思数据。

## 数据与隐私

运行数据默认保存在 <code>~/.hermes-reflection</code>，包括 JSON/JSONL 存储和本地 SQLite 会话索引。发布压缩包不含该目录，也不含用户配置、日志、数据库、依赖、内部计划、本机路径或凭据。

分享压缩包前应核对发布方提供的 SHA-256 与精确文件清单。不要把真实 config.toml、环境变量文件或用户记忆复制到项目目录。

## 许可证说明

此发布包未随附项目许可证，也未授予第三方复制、修改或再分发权。仓库发布者应在自己有权授权时另行选择许可证。上游 Hermes Agent 的许可证不会自动成为本项目的许可证。

本项目受 NousResearch Hermes Agent 本地源码快照的记忆与反思系统启发，但发布包不包含 Hermes Agent。
