# Hermes Reflection MCP v14.0.0

[English](README.en.md) | 简体中文

Hermes Reflection MCP 是一个本地 `stdio` MCP Server，用来给编码 Agent 提供可持久化、可检索、可复用的任务记忆。

它适合那些会反复进行开发、调试、维护 RAG、打包发布、跑 smoke test、调用 worker，或者在同一个项目上持续排障的 Agent。与其让经验在一次对话结束后丢失，不如把任务结果、经验教训、未解决问题和安全路径结构化保存下来，供下一次工作直接复用。

这个服务是 local-first 的，不依赖远程 API。它通过 `stdio` 与 MCP 客户端通信，并把数据写入用户主目录下的 JSON 文件。

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能概览](#功能概览)
- [v14.0.0 新增内容](#v1400-新增内容)
- [架构](#架构)
- [环境要求](#环境要求)
- [从发布压缩包安装](#从发布压缩包安装)
- [从源码安装](#从源码安装)
- [Codex Desktop 配置](#codex-desktop-配置)
- [通用 MCP 客户端配置](#通用-mcp-客户端配置)
- [首次验证](#首次验证)
- [推荐的 Agent 工作流](#推荐的-agent-工作流)
- [数据模型](#数据模型)
- [存储文件](#存储文件)
- [工具总览](#工具总览)
- [工具注解](#工具注解)
- [安全说明](#安全说明)
- [备份恢复与迁移](#备份恢复与迁移)
- [项目经验 Markdown 导出](#项目经验-markdown-导出)
- [开发与验证](#开发与验证)
- [发布打包](#发布打包)
- [常见问题](#常见问题)
- [仓库结构](#仓库结构)
- [发布到 GitHub 的建议](#发布到-github-的建议)
- [版本历史](#版本历史)

## 它解决什么问题

长周期工程任务很容易重复踩坑，比如：

- smoke test 忘了同时设置 `HOME` 和 `USERPROFILE`
- worker 一次被委派太多任务，超时或跑偏
- 发布包不小心混入缓存目录
- 老数据导入时漏掉新版本字段
- 某类调试任务已经有一套被验证过的安全命令
- 项目里有一些应该后续回看的 open questions

Hermes Reflection MCP 的目标，就是把这些经验保存成结构化记忆，让 Agent 在下一次开始相似任务前，可以先检索已有经验。

核心循环是：

1. 开工前先检索相关经验。
2. 执行任务并验证结果。
3. 任务结束后记录反思。
4. 下一次复用这些经验。

## 功能概览

- 结构化任务反思：记录 outcome、failure mode、blockers、safe paths、open questions、world-model updates、tool insights、tags 和 lessons learned。
- 启发式经验库：从 reflection 中抽取 heuristic，按 task description、domain、confidence、tags 检索。
- 检索使用统计：记录 `retrieval_count`、`last_retrieved_at`，让高价值经验更容易继续被发现。
- Reflection 搜索与浏览：支持 query、domain、outcome、failure mode、tags、session id、时间范围筛选。
- Session 摘要：适合交接、自检和阶段复盘。
- Open question 跟踪：支持单条问题的 resolved 状态维护。
- Affordance gap 跟踪：记录缺少的权限、工具或环境能力。
- World model 聚合：把反思里提炼出的事实整理成当前知识视图。
- Project experience Markdown 导出：适合交付、沉淀或喂给 RAG。
- Store health 检查：检查 orphan records、版本链、文件大小、可疑 heuristic、超大 reflection 等问题。
- Import / export / snapshot：支持备份、恢复、迁移和审计。
- MCP tool annotations：区分只读、变更型、破坏型工具。
- 可复用的 smoke test：通过临时目录运行，不污染真实记忆。

## v14.0.0 新增内容

v14.0.0 是在 v13 基础上的性能和 Agent 工作流升级版本，工具总数从 35 增加到 37。

### 性能优化

- Heuristic 去重在 Jaccard 预过滤通过后，直接复用候选对象引用，避免额外的全表查找。
- 空 query 的 reflection 浏览会复用缓存好的时间顺序提示，不再每次重复判断顺序。
- timeline、open questions、summary、domain summary、prune、store health 等热点路径减少了不必要的全量排序和临时数组。
- tag 过滤改为使用规范化 tag-set 索引，减少热路径上的重复标准化。

### 新增和增强工具

- 新增 `bulk_retrieve_heuristics`：一次请求里为多个任务描述批量检索经验，并避免重复增加 retrieval stats。
- 新增 `update_reflection`：允许修正已有 reflection 的 `domain`、`tags`、`lessons_learned`，并可选择重新抽取 heuristic。
- `get_domain_summary` 新增 `include_open_questions_detail:true`，可返回每个 domain 的重点未解决问题明细。

### 之前版本的重要增强

- v13.0.0 增加了 `reflect_on_task(dry_run:true)`、`export_project_experience_md.tag_mode` 和 `get_domain_summary`。
- v12.0.0 增加了写入生命周期 heuristic 去重缓存、reflection tag-mode 对齐、`get_reflection.apply_resolved_overlay` 和 `snapshot`。

## 架构

Hermes Reflection MCP 是一个基于 TypeScript 的 MCP Server，主要使用：

- `@modelcontextprotocol/sdk`
- `zod`
- Node.js 文件系统 API

运行链路：

```text
MCP client
  |
  | stdio JSON-RPC
  v
dist/index.js
  |
  | 校验工具输入、格式化工具输出
  v
dist/storage.js
  |
  | 串行化写入、JSONL reflection 存储、import/export
  v
~/.hermes-reflection/
```

核心源码文件：

- `index.ts`：MCP 工具定义、schema、handler、输出格式化
- `storage.ts`：store 读写、搜索、评分、剪枝、导入导出、健康检查、Markdown 导出
- `types.ts`：TypeScript 数据模型
- `scripts/smoke.mjs`：端到端 MCP smoke test
- `scripts/concurrency-test.mjs`：并发读写 smoke test

构建产物位于 `dist/`。

## 环境要求

- Node.js 18+
- npm
- 支持 `stdio` MCP Server 的客户端，例如 Codex Desktop
- Windows、macOS 或 Linux

下方示例优先使用 Windows 路径，因为 Codex Desktop 常见安装目录是：

```text
C:\Users\<YOU>\.codex
```

## 从发布压缩包安装

当另一个 Agent 或发布页提供你一个压缩包，例如：

```text
hermes-reflection-mcp-v14.0.0.zip
```

推荐流程：

1. 解压到稳定目录，例如：

   ```text
   C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp
   ```

2. 在该目录打开终端。

3. 安装生产依赖：

   ```powershell
   npm ci --omit=dev
   ```

4. 在 MCP 客户端配置中注册这个 Server。

5. 重启 MCP 客户端。

不要直接复制打包机器上的 `node_modules`。应始终在目标机器上执行 `npm ci --omit=dev`。

## 从源码安装

如果你是从 GitHub 克隆源码：

```powershell
git clone <REPO_URL> hermes-reflection-mcp
cd hermes-reflection-mcp
npm ci
npm run build
npm run smoke
```

构建完成后，让 MCP 客户端运行：

```text
node <repo-or-install-dir>\dist\index.js
```

如果你要把源码构建后的结果转成稳定安装目录，建议只复制以下白名单内容：

- `dist/`
- `scripts/smoke.mjs`
- `scripts/concurrency-test.mjs`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `README.md`
- `README.zh-CN.md`
- `CHANGELOG.md`
- `INSTALL_HERMES_MCP.md`
- `codex_config_snippet.toml`
- `index.ts`
- `storage.ts`
- `types.ts`

然后执行：

```powershell
npm ci --omit=dev
```

## Codex Desktop 配置

`C:\Users\<YOU>\.codex\config.toml` 的示例配置：

```toml
[mcp_servers.hermes-reflection]
type = "stdio"
command = "node"
args = ['C:\Users\<YOU>\.codex\mcp\hermes-reflection-mcp\dist\index.js']
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 300
```

Server 会在 MCP `initialize` 时发送自己的 instructions，因此 config 级别的 `instructions` 是可选覆盖项。

推荐自动批准的只读或低风险工具：

```toml
[mcp_servers.hermes-reflection.tools.retrieve_heuristics]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_reflection_summary]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.search_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.list_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_recent_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_affordance_gaps]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_open_questions]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_world_model]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_reflection_timeline]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_heuristic_history]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_heuristic_stats]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.diff_reflections]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.get_store_health]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.export_project_experience_md]
approval_mode = "auto"

[mcp_servers.hermes-reflection.tools.export_data]
approval_mode = "auto"
```

不建议自动批准 `clear_data`，因为它具有破坏性。

## 通用 MCP 客户端配置

对于任意支持 `stdio` 的 MCP 客户端，关键配置都类似：

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["<INSTALL_DIR>/dist/index.js"]
}
```

如果客户端支持设置 working directory，建议指向安装目录。实际数据默认仍然写到用户主目录，而不是仓库目录。

## 首次验证

最安全的 smoke 方式，是使用临时 profile，避免误写真实记忆。

如果是源码目录并且安装了 dev dependencies：

```powershell
npm run smoke
node scripts\concurrency-test.mjs
```

期望输出类似：

```text
Hermes smoke passed with temporary HOME: <temp path>
hermes-reflection-mcp v14.0.0 ready (store: <temp path>/.hermes-reflection)
```

如果是仅生产依赖安装的目录，`npm run smoke` 可能不可用，因为它会先跑 `npm run build`，而构建需要 TypeScript。此时更推荐直接对安装后的 `dist/index.js` 做 MCP 探针。

最少应验证：

- `initialize` 返回版本 `14.0.0`
- `tools/list` 返回 37 个工具
- `bulk_retrieve_heuristics` 存在
- `update_reflection` 存在
- `get_domain_summary` 支持 `include_open_questions_detail`

## 推荐的 Agent 工作流

Hermes 适合有工程价值的任务，不必用于每一条闲聊。

开工前：

```text
retrieve_heuristics({
  "task_description": "Fix failing package release smoke for Hermes MCP",
  "domain": "hermes-reflection-mcp",
  "limit": 5
})
```

工作中：

```text
log_affordance_gap({
  "session_id": "release-2026-06-08",
  "goal_description": "Verify package zip on a clean machine",
  "failure_description": "No tool can launch an isolated VM",
  "missing_capability": "clean-machine verification environment"
})
```

工作后：

```text
reflect_on_task({
  "session_id": "release-2026-06-08",
  "task_goal": "Package Hermes Reflection MCP v14.0.0",
  "task_outcome": "success",
  "failure_mode": "success",
  "summary": "Built, installed, packaged, scanned, and verified v14.0.0.",
  "lessons_learned": [
    "Validate production-only MCP installs with a direct dist/index.js smoke."
  ],
  "domain": "hermes-reflection-mcp",
  "tags": ["release", "mcp"]
})
```

会话结束时：

```text
get_session_summary({ "session_id": "release-2026-06-08" })
export_project_experience_md({
  "session_id": "release-2026-06-08",
  "output_dir": "D:\\RAG\\documents"
})
```

## 数据模型

### Reflection

Reflection 表示一次任务的结构化记录，通常包含：

- 任务目标
- 结果
- 失败类型
- 摘要
- 更长的分段总结
- blockers
- hypotheses
- safe paths
- open questions
- lessons learned

### Heuristic

Heuristic 是可复用的经验片段，包含：

- 文本内容
- 来源任务
- confidence
- domain
- tags
- reinforcement / contradiction / retrieval 统计
- supersedes / superseded_by 版本链

### Session

Session 用于把一组相关任务串起来，方便：

- 复盘
- 交接
- 导出项目经验

### Affordance Gap

Affordance gap 用于记录“想做但做不了”的原因，例如：

- 没有权限
- 缺少工具
- 环境能力不足

### Open Question

Open question 用于记录当前还没解答、之后应继续跟进的问题。

## 存储文件

默认目录：

```text
~/.hermes-reflection/
```

主要文件：

- `store.json`
- `reflections.jsonl`
- `resolved_questions.json`

如果你要做测试，建议先把 `HOME` 和 `USERPROFILE` 指向临时目录。

## 工具总览

当前服务暴露 37 个工具。

主要工具分组如下：

- Reflection 写入：
  `reflect_on_task`、`bulk_reflect`、`log_affordance_gap`、`resolve_affordance_gap`
- Heuristic 检索与维护：
  `retrieve_heuristics`、`bulk_retrieve_heuristics`、`list_heuristics`、`search_heuristics`、`get_heuristic_stats`、`add_heuristic`、`contradict_heuristic`、`delete_heuristic`、`update_heuristic`、`pin_heuristic`、`merge_heuristics`、`get_heuristic_history`
- Reflection 读取与修正：
  `search_reflections`、`list_reflections`、`diff_reflections`、`get_reflection_summary`、`get_recent_reflections`、`get_session_reflections`、`get_session_summary`、`get_reflection`、`update_reflection`
- Open questions：
  `get_open_questions`、`resolve_open_question`
- World model / timeline / domain：
  `get_world_model`、`get_reflection_timeline`、`get_domain_summary`
- 健康、导出、导入、破坏性操作：
  `get_store_health`、`export_project_experience_md`、`export_data`、`import_data`、`snapshot`、`clear_data`

更细的字段和行为说明，请优先查看英文版 [README.md](README.md) 中的完整 Tool Reference；英文版目前是最完整的逐工具细节说明。

## 工具注解

Hermes 会在工具注解中标注：

- 只读工具
- 变更型工具
- 破坏型工具

一般来说：

- 检索、查询、摘要、健康检查属于只读
- retrieval 统计更新、反思写入、导出到文件属于变更型
- `clear_data` 属于破坏型

## 安全说明

### 不要存储 Secret

不要把以下内容写入 reflection 或 heuristic：

- API keys
- auth tokens
- cookies
- 私有配置值
- 本机敏感路径下的私有内容

### 可疑启发式文本

Hermes 会对明显可疑的 heuristic 文本做保护处理。普通工具输出会屏蔽可疑文本；如果确实需要审计原始记录，应明确使用导出工具查看。

### 破坏性操作

`clear_data` 必须带 `confirm:true`，而且不建议默认自动批准。

### 导入和文件输出安全

- 导入前先做备份
- 文件输出前明确目标路径
- 发布包时使用白名单复制策略

## 备份恢复与迁移

### 备份

优先方式：

- `export_data(...)`
- `snapshot(...)`

### Merge 恢复

适合把一部分历史并回当前 store：

```text
import_data({ "input_path": "backup.json", "mode": "merge" })
```

### Replace 恢复

适合完整替换：

```text
import_data({ "input_path": "backup.json", "mode": "replace" })
```

### 恢复后验证

建议恢复后立即运行：

- `get_store_health`
- `get_reflection_summary`
- 若有需要，再做一次临时 HOME 的 smoke

## 项目经验 Markdown 导出

`export_project_experience_md` 适合：

- 项目交接
- 阶段总结
- RAG 文档沉淀

支持：

- `session_id`
- `domain`
- `tags`
- `since_days`
- `limit`
- `format: "markdown" | "plaintext" | "json"`
- `output_path`
- `output_dir`
- `include_raw_reflections`

## 开发与验证

常用命令：

```powershell
npm ci
npm run build
npm run smoke
node scripts\concurrency-test.mjs
```

发布前至少验证：

- 构建通过
- smoke 通过
- concurrency test 通过
- 文档版本号与工具数一致
- 安装目录可被 MCP 客户端直接加载

## 发布打包

推荐使用白名单打包策略，只包含：

- `dist/`
- `scripts/`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `README.md`
- `README.zh-CN.md`
- `CHANGELOG.md`
- `INSTALL_HERMES_MCP.md`
- `codex_config_snippet.toml`
- `index.ts`
- `storage.ts`
- `types.ts`

不要打包：

- `.env`
- `mem.md`
- `AGENTS.md`
- `SKILL.md`
- `.git`
- `.claude`
- `node_modules`
- logs、cache、bytecode、临时输出目录
- 本机私有路径或私有配置

## 常见问题

### MCP Server 无法启动

先检查：

- Node.js 版本是否满足要求
- `dist/index.js` 是否存在
- MCP 配置中的路径是否正确
- 是否已执行 `npm ci` 或 `npm ci --omit=dev`

### Codex Desktop 里仍然显示旧版本

通常需要：

- 替换安装目录内容
- 检查 `config.toml` 指向的是否是你刚更新的目录
- 重启 Codex Desktop

### 生产安装里 `npm run smoke` 失败

原因通常是生产安装用了：

```powershell
npm ci --omit=dev
```

这样没有 TypeScript。因为 `npm run smoke` 会先执行 `npm run build`，所以会失败。此时请改用直接探测安装后的 `dist/index.js`。

### 测试时误改了真实记忆

先检查：

```text
~/.hermes-reflection
```

然后使用：

- `export_data`
- `get_store_health`
- `snapshot`

来确认和修复。

### `get_store_health` 报 orphan records

通常是导入时 session、reflection、gap 没有成套进入。建议先导出备份，再补齐来源数据后重新导入。

### `retrieve_heuristics` 结果价值不高

可以尝试：

- 提高 `min_confidence`
- 增加 `domain`
- 增加 `tags`
- 使用 `show_scores:true` 观察排序

## 仓库结构

```text
.
|-- index.ts
|-- storage.ts
|-- types.ts
|-- scripts/
|   |-- smoke.mjs
|   `-- concurrency-test.mjs
|-- dist/
|   |-- index.js
|   |-- storage.js
|   `-- types.js
|-- package.json
|-- package-lock.json
|-- tsconfig.json
|-- README.md
|-- README.zh-CN.md
|-- CHANGELOG.md
|-- INSTALL_HERMES_MCP.md
`-- codex_config_snippet.toml
```

## 发布到 GitHub 的建议

如果这个仓库要公开发布，比较合适的文档组合是：

- `README.md`：英文主文档
- `README.zh-CN.md`：中文主文档
- `INSTALL_HERMES_MCP.md`：安装操作说明
- `CHANGELOG.md`：版本变化记录

同时建议：

- 添加 `LICENSE`
- 检查文档里是否残留真实本机路径
- 不要提交 `node_modules`
- 不要提交本地 memory store
- 不要提交临时 release staging 目录
- 不要提交 secret 或私有配置

建议的 `.gitignore` 片段：

```gitignore
node_modules/
.hermes-reflection/
release/*.tmp
*.log
.pytest_cache/
__pycache__/
coverage/
```

## 版本历史

### v14.0.0

- 优化 heuristic 去重、reflection 浏览、timeline、summary、prune、health、tag filter 等热点路径。
- 新增 `bulk_retrieve_heuristics`。
- 新增 `update_reflection`。
- `get_domain_summary` 支持 `include_open_questions_detail:true`。
- 工具数增加到 37。

### v13.0.0

- 增加 `reflect_on_task(dry_run:true)`。
- 增加 `export_project_experience_md.tag_mode`。
- 增加 `get_domain_summary`。
- 工具数增加到 35。

### v12.0.0

- 增加写入生命周期 heuristic 去重缓存。
- 优化 affordance gap、session summary、experience export、health、resolved-question cache 等路径。
- 增加 `search_reflections.tag_mode` 和 `list_reflections.tag_mode`。
- 增加 `get_reflection.apply_resolved_overlay`。
- 增加 `snapshot`。

更完整的版本细节请查看 [CHANGELOG.md](CHANGELOG.md)。
