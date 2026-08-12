# Hermes Reflection MCP v21.1.0

Hermes Reflection MCP 是面向 Codex Desktop 的本地 Agent-first 记忆与反思服务器。v21.1.0 保留严格有序的 10 工具默认配置和全部 29 个兼容工具，同时修复当前 Codex hook 生命周期语义、降低 MCP 上下文占用，并加入默认关闭的安全对话轮次捕获。

所有记忆都只是历史参考，绝不是指令。当前用户请求、当前文件、URL 和实时系统始终优先。

## Agent-first 默认工具

推荐只向 Codex 暴露以下 10 个工具：

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

完整兼容层仍有 29 个工具。配置示例见 [`codex_config_snippet.toml`](codex_config_snippet.toml)。

## Token 与上下文控制

- `retrieve_heuristics` 未填写 `limit` 时默认只返回 3 条紧凑结果。
- 当前文件或实时来源已足够时，应跳过记忆检索；需要证据细节时再用 `get_memory_item`。
- 长结果默认 `response_mode: "compact"`，上限为 6,000 个 Unicode 码点和 24 KiB；完整模式上限为 20,000 个码点和 80 KiB。
- 默认 10 工具的 schema + description + server instructions 总量受 15,000 字符预算约束；服务器说明不超过 512 个码点。
- 紧凑启发式结果只含 `id`、`heuristic` 和 `confidence`，避免重复携带可按需获取的元数据。

## Codex 生命周期语义

hook CLI 支持当前官方事件：`SessionStart`、`UserPromptSubmit`、`Stop`、`PreCompact`、`PostCompact` 和 `SessionEnd`。

- `Stop` 只表示一轮结束，绝不会结束会话、释放项目作用域或快照。
- 只有 `SessionEnd` 才持久化会话结束、释放状态，并在确有新 reflection 时安排后台复盘。
- 官方 `PreCompact`/`PostCompact` 不需要 Hermes 私有元数据。两者记录有界观察；`PostCompact` 刷新新上下文代的冻结快照。
- 只有直接集成显式提供完整、验证通过的扩展元数据时，才会写入可信压缩回执；官方普通事件不会伪造回执。
- turn-scoped 事件身份包含事件类型、session、turn、触发/状态或规范化内容哈希，精确重放幂等，不同轮次不会错误折叠。

## 默认关闭的对话轮次捕获

默认安装只注册 `SessionStart`、`SessionEnd`、`PreCompact` 和 `PostCompact`。不会记录每轮聊天。

如明确需要本地捕获，请同时设置：

```text
HERMES_REFLECTION_CODEX_TURN_CAPTURE=true
```

并用安装器的 `--capture` 参数加入 `UserPromptSubmit` 和 `Stop`。捕获规则：

- 只读取 `prompt` 与 `last_assistant_message`，绝不读取 `transcript_path`、推理或工具轨迹；
- 每侧最多 12,000 个 Unicode 码点；
- 持久化前执行严格敏感信息清理与威胁扫描，高风险正文替换为不可逆 blocked 标记；
- 按 `session_id + turn_id` 原子配对 user/assistant，支持乱序、精确重放和冲突关闭式失败；
- 未配对内容在会话结束或 24 小时后清理；
- 捕获的原始轮次不会进入自动 LLM 复盘，也不会整段自动注入 Codex 上下文。

捕获关闭时，即使陈旧配置仍触发 Prompt/Stop hook，CLI 也会在持久化前丢弃正文并返回 `capture_disabled`。

## 自动 LLM 复盘

确定性复盘始终可用。LLM 复盘是独立 opt-in，只使用专用 OpenAI-compatible provider，绝不复用 Codex 登录凭据：

```text
HERMES_REFLECTION_LLM_ENABLED=true
HERMES_REFLECTION_LLM_BASE_URL=https://provider.example/v1
HERMES_REFLECTION_LLM_MODEL=your-model
HERMES_REFLECTION_LLM_API_KEY=<dedicated-provider-key>
```

自动复盘只发送最近 10 条同作用域结构化 reflection，并在严格清理后限制为 24,000 个序列化字符。source fingerprint 同时绑定选中 reflection 与模型、endpoint path、prompt/schema 版本；相同来源与配置不会重复调用，语义模型配置变化会触发新一轮。

认证、权限、配置和配额错误进入持久冷却；临时错误最多重试一次；关闭 MCP 会有界取消请求并释放租约。候选默认保持 `pending`，自动应用仍需独立开启，并受置信度、风险、证据新鲜度、审批状态和 fencing token 约束。

## 安装 hooks

构建或安装项目后运行：

```powershell
node scripts/install-codex-hooks.mjs --hooks "$env:USERPROFILE\.codex\hooks.json" --install-dir "$env:USERPROFILE\.codex\mcp\hermes-reflection-mcp"
```

安装器会创建同目录时间戳备份，结构化解析/合并/重解析 JSON，只移除识别出的 Hermes hook，并尽量保持其他产品 handler 与顺序。`--dry-run` 只报告是否需要变更；`--capture` 显式开启两类捕获 hook。去掉 `--capture` 重新运行即可只移除 Hermes 捕获项。

安装、工具面、instructions 或环境变量变更后，必须启动一个全新的 Codex Desktop 进程/任务，旧 MCP 进程不会热更新。

## 数据、迁移与回滚

用户数据位于 `~/.hermes-reflection`，不要放进源码或发布 ZIP。v21.1 保持主 store schema 2，并对 session SQLite 事务性加入 pending turn pairs 与 compaction observations；现有 v21 数据原地迁移，不会把观察伪装为可信回执。

升级前分别备份安装目录和 `~/.hermes-reflection`。先在干净 staging 安装、验证，再切换稳定路径。失败时停止 Codex，恢复匹配的上一版代码、数据和 hooks/config 备份，再启动新进程。

## 开发验证

需要 Node.js 20 或更高版本：

```powershell
npm ci
npm run test:strict
npm run build
npm run smoke
npm run test:regressions
npm run test:v20
npm run test:v21
npm run test:v21.1
npm run test:concurrency
npm run test:v20:agent-fixture
npm pack --dry-run --json
npm audit --omit=dev
```

CI 在 Windows/Linux 的 Node 20 与 22 上执行严格类型、当前回归、v21/v21.1 生命周期/事务/安全/发布、并发、打包白名单和生产依赖审计。安装细节见 [`INSTALL_HERMES_MCP.md`](INSTALL_HERMES_MCP.md)，版本记录见 [`CHANGELOG.md`](CHANGELOG.md)。
