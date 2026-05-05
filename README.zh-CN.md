# Seek Code

<p align="center">
  <strong>专注 DeepSeek 生态的终端原生 Code Agent</strong>
</p>

<p align="center">
  围绕 <code>deepseek-v4-pro</code>、长上下文推理、thinking stream 和工程工具链构建，
  让 DeepSeek 模型真正进入你的工作区。
</p>

<p align="center">
  <a href="./README.md"><strong>English</strong></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#快速开始">快速开始</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#deepseek-生态优先">DeepSeek 生态优先</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#架构设计">架构设计</a>
</p>

<p align="center">
  <a href="#快速开始"><img alt="Quickstart" src="https://img.shields.io/badge/Quickstart-3%20Commands-1677ff?style=for-the-badge"></a>
  <a href="#deepseek-生态优先"><img alt="DeepSeek" src="https://img.shields.io/badge/DeepSeek-V4%20Pro%20First-0f172a?style=for-the-badge"></a>
  <a href="#运行模式"><img alt="Modes" src="https://img.shields.io/badge/Modes-Plan%20%7C%20Agent%20%7C%20YOLO-22c55e?style=for-the-badge"></a>
  <a href="#工具系统"><img alt="Tools" src="https://img.shields.io/badge/Tools-File%20Shell%20Git%20Web%20MCP-334155?style=for-the-badge"></a>
  <a href="#开发与验证"><img alt="Node" src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=for-the-badge&logo=node.js&logoColor=white"></a>
</p>

<p align="center">
  <code>npm install -g seekcode</code>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <code>seek</code>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <code>seek "review this repo"</code>
</p>

---

## 目录

- [项目定位](#项目定位)
- [DeepSeek 生态优先](#deepseek-生态优先)
- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [日常使用](#日常使用)
- [运行模式](#运行模式)
- [界面与交互](#界面与交互)
- [工具系统](#工具系统)
- [配置系统](#配置系统)
- [Provider 与模型](#provider-与模型)
- [MCP 集成](#mcp-集成)
- [Skills 与项目上下文](#skills-与项目上下文)
- [会话、回滚与成本](#会话回滚与成本)
- [HTTP/SSE Server](#httpsse-server)
- [架构设计](#架构设计)
- [开发与验证](#开发与验证)
- [安全边界](#安全边界)
- [命令速查](#命令速查)
- [License](#license)

---

## 项目定位

Seek Code 是一个 **DeepSeek-first terminal-native coding agent**。它不是聊天机器人套一个 CLI，也不是只能生成代码片段的问答工具，而是一个围绕 DeepSeek 模型能力设计、会在本地仓库中完成工程动作的代理：

- 它能读取和理解项目结构，按任务拆解工作。
- 它能编辑文件、应用 patch、运行测试、查看 Git 状态。
- 它能根据模式决定是否需要人工确认。
- 它能把复杂工作拆成 checklist、plan、task、sub-agent。
- 它能通过 MCP、Web、Skills 扩展自己的工具面。
- 它能保存会话、追踪 token 和成本，并在需要时回滚工作区。

Seek Code 的核心目标是：**把 DeepSeek V4 Pro 的长上下文与强推理能力变成一个谨慎但高效的工程代理，在你的终端里完成可验证的开发工作。**

---

## DeepSeek 生态优先

Seek Code 从默认模型、请求格式、能力矩阵、缓存统计、thinking 事件、Flash 侧路查询到 SGLang 本地部署，都围绕 DeepSeek 生态构建。

`deepseek-v4-pro` 是默认模型，因为它非常适合代码代理：

| 能力 | 对 Code Agent 的价值 |
|---|---|
| 1M-token 上下文窗口 | 能读更大的仓库、更长的日志、更复杂的 diff 和更完整的多轮历史。 |
| 强推理能力 | 适合跨模块重构、复杂 bug 定位、测试失败分析、配置迁移和架构设计。 |
| Thinking stream | 长任务过程中可以持续看到模型思考事件，交互不再是黑盒等待。 |
| 大输出预算 | 能承载完整计划、详细报告、结构化说明和复杂 patch 解释。 |
| 缓存遥测 | provider 支持时可在 UI 和成本追踪里展示 cache token 信息。 |

`deepseek-v4-flash` 则适合快速总结、轻量 one-shot 和 `rlm_query` 并行侧路分析。Seek Code 的定位不是“顺便支持 DeepSeek”，而是 **为 DeepSeek 模型生态专门打造工程 agent runtime**。

---

## 核心能力

| 能力 | 说明 | 面向场景 |
|---|---|---|
| 终端原生交互 | 直接在终端中输入需求、查看工具调用、批准危险操作 | 日常开发、代码审查、仓库理解 |
| 三种运行模式 | `plan` 只读、`agent` 交互批准、`yolo` 自动执行 | 从安全探索到高速执行 |
| 工具注册表 | 文件、Shell、Git、Web、任务、制品、MCP、诊断等统一注册 | 可扩展 agent runtime |
| DeepSeek V4 适配 | 默认 `deepseek-v4-pro`，支持 thinking、长上下文、缓存统计 | 大型仓库和复杂推理 |
| 分解优先 | 系统提示强调 preview、checklist、plan、map-reduce | 复杂需求、跨模块改造 |
| 子代理并行 | `spawn_agent`、`sub_agent` 支持并行探索和执行 | 多模块调查、并行实现 |
| 会话持久化 | `/save`、`/load`、`/sessions` 管理历史会话 | 中断后继续工作 |
| 工作区回滚 | side-git 在 `.deepseek/side-git` 记录 turn 快照 | 防止误改和快速恢复 |
| HTTP/SSE 服务 | 以 server 模式暴露会话、线程、工具和流式聊天 API | 集成到上层产品或自动化系统 |

---

## 快速开始

### 1. 安装

```bash
npm install -g seekcode
```

### 2. 设置 API Key

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
```

### 3. 启动交互模式

```bash
seek
```

进入后可以直接输入自然语言任务：

```text
read this repository and explain the architecture
```

也可以直接使用 slash command：

```text
/help
/plan
/tokens
/sessions
```

### One-shot 模式

如果命令后带 prompt，Seek Code 会执行一次性请求并退出：

```bash
seek "summarize the project structure"
seek --mode plan "review the current git diff"
seek -r max "think deeply about how to refactor the engine loop"
```

---

## 日常使用

### 理解陌生仓库

```bash
seek --mode plan
```

```text
先阅读项目结构，说明入口、核心模块、数据流和测试覆盖情况
```

`plan` 模式只允许只读工具，适合代码审计、架构理解和改造前调研。

### 执行一个安全的代码修改

```bash
seek --mode agent
```

```text
修复 tests 里失败的用例，先说明原因，再修改并运行相关测试
```

`agent` 模式会自动运行只读工具，遇到写文件、patch、shell 等操作时请求确认。

### 高速完成可信任务

```bash
seek --mode yolo
```

```text
把这个模块补齐单元测试并运行 npm test
```

`yolo` 模式会自动批准大多数工具调用。适合你已经信任当前任务范围、希望快速推进时使用。

---

## 运行模式

| 模式 | 权限行为 | 推荐用途 |
|---|---|---|
| `plan` | 只读探索。允许 `read`、`ls`、`search`、`glob`、Git diff/log/status、Web、plan/note 等安全工具 | 读代码、做方案、审查风险 |
| `agent` | 默认模式。只读工具自动执行，写入、Shell、patch、MCP 变更等需要确认 | 日常开发和结对编程 |
| `yolo` | 自动批准非 dangerous 工具。仍保留危险操作保护 | 高信任环境下的快速实现 |

切换模式：

```text
/plan
/agent
/yolo
```

也可以在交互界面按 `Shift+Tab` 循环切换：

```text
plan -> agent -> yolo -> plan
```

---

## 界面与交互

Seek Code 的界面围绕“清楚地看见 agent 正在做什么”设计：

| 区域 | 作用 |
|---|---|
| 顶部状态 | 展示当前 mode、model、workspace、cache、tools、cost 等信息 |
| 对话流 | 展示用户输入、模型输出、thinking/content 分段 |
| 工具行 | 展示工具开始、执行结果和简短 preview |
| 选择器 | 用于会话选择、模型切换、权限确认等交互 |
| 输入栏 | 支持 slash command、Tab 补全、中文路径和多字节光标移动 |

默认使用 inline 模式，保留终端原生 scrollback：

```bash
seek --no-alt-screen
```

需要更沉浸的全屏体验时：

```bash
seek --alt-screen
```

常用交互键：

| 按键 | 行为 |
|---|---|
| `Tab` | slash command 补全 |
| `Shift+Tab` | 循环切换 mode |
| `Ctrl+C` | 退出 |
| `Esc` | 中断正在执行的 turn |
| `PageUp` / `PageDown` | 滚动 transcript |

---

## 工具系统

Seek Code 所有能力都通过统一 Tool Registry 暴露给模型。工具有名称、描述、JSON schema、权限级别、分类和是否可并行执行等元信息。

### 工具分类

| 分类 | 代表工具 | 用途 |
|---|---|---|
| File | `read`、`write`、`edit`、`ls`、`search`、`glob`、`apply_patch` | 文件读取、检索、修改和 patch |
| Shell | `bash`、`task_shell_start`、`task_shell_wait`、`exec_shell_wait` | 前台命令、后台任务、长任务管理 |
| Git | `git_status`、`git_diff`、`git_log`、`git_branch` | 查看工作区和提交历史 |
| Web | `web_search`、`web_fetch`、`fetch_url` | 搜索和抓取网页资料 |
| Plan | `checklist_write`、`update_plan`、`plan_status`、`note` | 任务拆解、进度维护和记录 |
| Goal | `create_goal`、`get_goal`、`update_goal` | 目标追踪和 token 预算 |
| Agent | `spawn_agent`、`sub_agent`、`agent_status` | 子代理并行工作 |
| Task | `task_create`、`task_list`、`task_read`、`task_cancel`、`task_complete` | 长任务生命周期管理 |
| Artifact | `artifact_create`、`artifact_list`、`artifact_read`、`artifact_link` | 保存大型日志、补丁、诊断证据 |
| Diagnostics | `diagnostics`、`lsp_diagnostics`、GitHub/PR 辅助工具 | 质量检查、证据归档、PR 工作流 |
| MCP | `mcp_<server>_<tool>` | 外部 MCP server 提供的工具 |
| Meta | `think`、`rlm_query`、`tool_search`、`tool_stats`、`tool_enable` | 推理、并行查询、工具发现和恢复 |

### 工具激活策略

不是所有工具都会一次性塞进模型上下文。Registry 支持 active tool 集合：

- 常用只读工具和规划工具默认 active。
- 部分工具可以延迟加载，减少上下文噪声。
- Agent 会根据用户输入自动激活相关工具。
- 失败过多的工具会被降级禁用，可通过 `tool_enable` 恢复。

### Shell 执行策略

Shell 工具由 exec policy 保护。默认规则包含：

- 允许安全读取类命令，例如 `ls`、`pwd`、`cat`、`grep`、`git diff`、`npm test`、`npm run build`。
- 拒绝明显危险操作，例如 `rm -rf /`、写裸设备、`mkfs`、fork bomb、`chmod -R 777`。
- 未命中规则的命令在 `agent` 模式中会请求确认。

---

## 配置系统

Seek Code 使用分层配置，后面的来源覆盖前面的来源：

| 优先级 | 来源 | 位置 |
|---|---|---|
| 1 | 默认值 | 代码内默认配置 |
| 2 | 用户配置 | `~/.config/deepseek/config.toml` |
| 3 | 项目配置 | `.deepseek/config.toml` |
| 4 | 环境变量 | `DEEPSEEK_*` |
| 5 | CLI 参数 | `--model`、`--mode`、`--api-key` 等 |

### 最小配置

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
```

### 常用环境变量

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
export DEEPSEEK_PROVIDER="deepseek"
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
export DEEPSEEK_MODEL="deepseek-v4-pro"
export DEEPSEEK_FLASH_MODEL="deepseek-v4-flash"
export DEEPSEEK_MODE="agent"
export DEEPSEEK_MAX_TOKENS="8192"
export DEEPSEEK_REASONING_EFFORT="high"
export DEEPSEEK_TUI_ALTERNATE_SCREEN="never"
```

### 完整配置示例

```toml
# ~/.config/deepseek/config.toml

api_key = "sk-your-api-key"
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
flash_model = "deepseek-v4-flash"

mode = "agent"
max_tokens = 8192
max_turns = 50
context_limit = 1000000
reasoning_effort = "high"

rollback_enabled = true
cost_tracking = true
thinking_visible = true
tui_alternate_screen = "never"

approval_policy = "on-request"
sandbox_mode = "workspace-write"
workspace_boundary = true
trusted_workspaces = []

theme = "deepseek-dark"
context_refresh_enabled = true
lsp_auto_diagnostics = true
lsp_diagnostics_severity = "warning"

tool_call_budget_per_turn = 80
tool_failure_degrade_threshold = 3
status_items = ["mode", "model", "workspace", "cache", "tools", "cost", "hints"]

[web]
enabled = true
mode = "live"
# auto 会优先使用已配置的 API 搜索引擎，再回退到 Bing/DuckDuckGo。
# 支持：auto, google, exa, kagi, brave, tavily, serper, searxng,
# arxiv, semantic_scholar, pubmed, baidu, bing, duckduckgo。
search_engine = "auto"
allowed_domains = []
blocked_domains = []
google_api_key = ""
google_cx = ""
exa_api_key = ""
kagi_api_key = ""
brave_api_key = ""
tavily_api_key = ""
serper_api_key = ""
semantic_scholar_api_key = ""
pubmed_api_key = ""
searxng_url = ""
proxy = ""
no_proxy = []
search_timeout_ms = 15000
fetch_timeout_ms = 15000
max_bytes = 1000000
```

### 配置管理命令

```bash
seek config validate
seek config explain
seek config migrate --target user --dry-run
seek config migrate --target project
```

交互模式中也可以使用：

```text
/config validate
/config explain
/config migrate user --dry-run
/config migrate project
```

---

## Provider 与模型

Seek Code 默认面向 DeepSeek，同时保留多个 OpenAI-compatible provider 的适配：

| Provider | 默认 Base URL | 模型名处理 |
|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-pro`、`deepseek-v4-flash` |
| `deepseek-cn` | `https://api.deepseeki.com` | 同 DeepSeek |
| `nvidia-nim` | `https://integrate.api.nvidia.com/v1` | 自动映射为 `deepseek-ai/...` |
| `openrouter` | `https://openrouter.ai/api/v1` | 自动映射为 `deepseek/...` |
| `novita` | `https://api.novita.ai/v1` | 自动映射为 `deepseek/...` |
| `fireworks` | `https://api.fireworks.ai/inference/v1` | 自动映射为 `accounts/fireworks/models/...` |
| `sglang` | `http://localhost:30000/v1` | 自动映射为 `deepseek-ai/DeepSeek-V4-*` |

切换 provider：

```bash
seek --provider openrouter --api-key "$OPENROUTER_API_KEY"
```

交互中切换：

```text
/provider
/provider deepseek
/provider sglang
/model
/model deepseek-v4-flash
/capabilities
```

Reasoning effort：

```bash
seek -r off "summarize this file"
seek -r high "implement this change carefully"
seek -r max "design a migration plan"
```

交互中循环：

```text
/reasoning
```

循环顺序：

```text
off -> low -> medium -> high -> max -> xhigh -> off
```

---

## MCP 集成

Seek Code 支持 Model Context Protocol。启动时会连接配置中的 MCP server，并把 server 暴露的工具注册为：

```text
mcp_<server_name>_<tool_name>
```

### 配置示例

```toml
# .deepseek/config.toml

[[mcp_servers]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
env = {}
enabled = true

[[mcp_servers]]
name = "remote-tools"
transport = "sse"
url = "https://example.com/mcp"
enabled = true
```

### 交互管理

```text
/mcp list
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp
/mcp enable filesystem
/mcp disable filesystem
/mcp remove filesystem
/mcp reload
```

MCP 工具默认需要确认，适合连接 GitHub、文件系统、数据库、内部服务等外部能力。

---

## Skills 与项目上下文

### Skills

Skills 用于把领域经验、项目约定和工具流程注入 agent。每个 skill 由 `SKILL.md` 描述：

```markdown
---
name: typescript-conventions
description: TypeScript conventions for this repository
---

# TypeScript Conventions

- Prefer explicit return types on exported functions.
- Keep side effects close to the CLI boundary.
- Run npm test before claiming completion.
```

常用命令：

```text
/skills
/skills --remote
/skill typescript-conventions
/skill install <registry-name>
/skill install github:owner/repo
/skill update <name>
/skill uninstall <name>
/skill trust <name>
```

### AGENTS.md

在仓库根目录放置 `AGENTS.md`，Seek Code 会在构建 system prompt 时注入项目规则：

```markdown
# Project Instructions

- Use TypeScript strict mode.
- Keep public CLI behavior backward compatible.
- Prefer focused tests for regression fixes.
```

适合写入团队约定、测试命令、目录边界和代码风格。

---

## 会话、回滚与成本

### 会话保存与恢复

```text
/save
/sessions
/load <session_id>
/delete <session_id>
/exit
```

会话默认保存到：

```text
~/.local/share/deepseek/sessions
```

也可以通过环境变量指定：

```bash
export DEEPSEEK_SESSIONS_DIR="/path/to/sessions"
```

### 工作区回滚

Seek Code 使用 side-git 保存 turn 前后的工作区快照，不污染你的项目 Git 仓库：

```text
.deepseek/side-git
```

查看快照：

```text
/restore
```

回滚最近一次 turn：

```text
/restore revert
```

### 成本与 token

```text
/tokens
/cost
```

`/tokens` 展示上下文占用和 capacity decision，`/cost` 展示 turn 级别和累计 token/cost 信息。

### Artifact

大型日志、诊断输出、PR 证据等可以落到 artifact store，避免把超长内容塞满上下文：

```text
artifact_create
artifact_list
artifact_read
artifact_link
artifact_links
```

默认位置：

```text
~/.local/share/deepseek/artifacts
```

可通过环境变量覆盖：

```bash
export DEEPSEEK_ARTIFACTS_DIR="/path/to/artifacts"
export DEEPCODE_ARTIFACTS_DIR="/path/to/artifacts"
```

---

## HTTP/SSE Server

Seek Code 可以作为 headless agent server 运行：

```bash
seek serve --host 0.0.0.0 --port 8080
```

### 常用端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/health` | 健康检查 |
| `POST` | `/v1/session` | 创建 session 和 thread |
| `GET` | `/v1/session/:session_id` | 查看 session |
| `GET` | `/v1/sessions` | 列出运行时 sessions |
| `DELETE` | `/v1/sessions/:session_id` | 删除 session |
| `POST` | `/v1/session/:session_id/chat` | 以 SSE 方式执行一次聊天 turn |
| `GET` | `/v1/tools` | 列出工具 |
| `GET` | `/v1/skills` | 列出 skills |
| `GET` | `/v1/threads` | 列出 threads |
| `POST` | `/v1/threads` | 创建 thread |
| `GET` | `/v1/threads/:thread_id` | 获取 thread 详情 |
| `PATCH` | `/v1/threads/:thread_id` | 更新 thread |
| `POST` | `/v1/threads/:thread_id/fork` | fork thread |
| `GET` | `/v1/threads/:thread_id/events` | 获取或订阅事件 |
| `GET` | `/v1/threads/:thread_id/items` | 获取 runtime items |
| `POST` | `/v1/threads/:thread_id/turns/:turn_id/interrupt` | 中断 turn |

### 示例

```bash
curl -s http://localhost:8080/v1/health
```

```bash
curl -s -X POST http://localhost:8080/v1/session
```

```bash
curl -N -X POST http://localhost:8080/v1/session/<session_id>/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"list the files in src and summarize the architecture"}'
```

SSE 事件包括：

```text
thinking
content
tool_call
tool_result
context_intervention
approval_required
done
error
interrupted
```

---

## 架构设计

### 总览

```text
                    User / CLI / HTTP API
                              |
                              v
                    src/index.ts / server/app.ts
                              |
                              v
          Config + Session + History + Tool Registry
                              |
                              v
                       Engine.runTurn()
                              |
             +----------------+----------------+
             |                                 |
             v                                 v
      DeepSeekClient                    Tool Execution
             |                                 |
             v                                 v
   Streaming events              File / Shell / Git / Web / MCP
             |                                 |
             +----------------+----------------+
                              |
                              v
                 Transcript / Session / Artifacts
```

### 目录结构

```text
src/
  index.ts                 CLI 入口、交互循环、slash commands
  config.ts                TOML、环境变量、CLI 参数合并和校验

  client/
    base.ts                模型客户端接口和 StreamEvent 类型
    capabilities.ts        provider/model 能力矩阵
    deepseek.ts            OpenAI-compatible client 封装
    streaming.ts           流式事件聚合辅助

  engine/
    loop.ts                ReAct 风格核心执行循环
    context.ts             system prompt 与工具描述组装
    compact.ts             上下文压缩策略
    context-manager.ts     上下文刷新和容量管理
    skills.ts              Skills 发现、安装、信任和注入
    agents-md.ts           AGENTS.md 注入
    hooks.ts               生命周期 hook
    task-lifecycle.ts      任务生命周期管理

  tools/
    base.ts                ToolDef、权限等级、OpenAI schema 转换
    registry.ts            全局工具注册表
    file-ops.ts            文件读写、检索和 glob
    shell.ts               shell 与后台任务
    exec-policy.ts         shell 安全策略
    git.ts                 Git 只读工具
    web.ts                 Web 搜索和抓取
    patch.ts               apply_patch 包装
    patch-advanced.ts      patch parser
    plan.ts                checklist、plan、note
    goal.ts                goal 和 token 预算
    sub-agent.ts           子代理
    rlm-query.ts           并行轻量查询
    tasks.ts               任务管理
    artifacts.ts           artifact 工具
    diagnostics.ts         诊断和 PR 辅助工具

  tui/
    layout.ts              终端布局
    transcript.ts          对话流
    assistant-stream.ts    模型输出流
    tool-lines.ts          工具执行行
    screen.ts              屏幕渲染基础

  ui/
    input.ts               raw-mode 输入、补全、快捷键
    renderer.ts            终端渲染
    markdown.ts            Markdown 渲染
    palette.ts             颜色系统
    picker.ts              选择器

  session/
    types.ts               session/message/turn 类型
    history.ts             会话历史
    store.ts               JSON 持久化
    title.ts               会话标题生成

  server/
    app.ts                 Hono app 和路由
    handlers.ts            HTTP/SSE handlers
    runtime-store.ts       server runtime 状态
    transport.ts           SSE transport

  mcp/
    protocol.ts            JSON-RPC/MCP 类型
    client.ts              stdio 和 SSE client
    manager.ts             MCP server 生命周期和工具注册

  rollback/
    side-git.ts            side-git 快照
    restore.ts             恢复入口

  cost/
    pricing.ts             价格表
    tracker.ts             token/cost 追踪
```

### 核心执行循环

一次 turn 的典型路径：

1. 用户输入自然语言任务。
2. CLI 根据当前配置、workspace、tools 和 skills 构建上下文。
3. Engine 调用模型并流式接收 thinking/content/tool calls。
4. Tool Registry 查找工具定义，Mode 决定是否允许执行。
5. 工具结果写回 history，必要时生成 runtime item 或 artifact。
6. Engine 继续迭代直到模型输出最终回答。
7. Session、cost、turn、snapshot 等状态更新。

---

## 开发与验证

### 环境要求

- Node.js `>= 22`
- npm
- DeepSeek API key 或兼容 provider 的 API key

### 从源码运行

```bash
git clone <repo-url>
cd seekcode
npm install
npm run build
npm link
seek --version
```

开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

测试：

```bash
npm test
```

`npm test` 会先执行 `npm run build`，保证 `dist/index.js` 存在，并验证源码入口和构建产物入口。

### 当前测试覆盖

测试位于 `tests/`：

| 文件 | 关注点 |
|---|---|
| `client-regression.test.ts` | 客户端、流式解析、provider 行为 |
| `cli-regression.test.ts` | CLI 参数、help/version、交互启动、dist 入口 |
| `modes-regression.test.ts` | plan/agent/yolo 权限行为 |
| `runtime-regression.test.ts` | runtime、任务、shell 等行为 |
| `server-regression.test.ts` | HTTP/SSE server |
| `session-regression.test.ts` | session 保存、加载、列表、删除 |
| `tools-regression.test.ts` | 文件、patch、git、skills、MCP、artifact、诊断等工具 |
| `ui.test.ts` | 输入、渲染、布局、Markdown、picker |
| `web-regression.test.ts` | web search/fetch、安全限制、代理配置 |

---

## 安全边界

Seek Code 是能改文件、跑命令、访问网络的工程 agent。建议按场景选择模式和工作区：

| 建议 | 原因 |
|---|---|
| 首次进入陌生仓库使用 `--mode plan` | 先读清楚上下文，不产生写入 |
| 重要仓库使用 `agent` 模式 | 写入、Shell、patch 前保留人工确认 |
| `yolo` 只用于可信任务和可恢复环境 | 自动执行带来速度，也放大误操作成本 |
| 开启 Git 并保持干净工作区 | 便于审查 diff 和回退 |
| 不要把真实密钥写进项目文件 | `.env`、`api.txt`、`.npmrc` 默认应被 ignore |
| 谨慎连接 MCP server | MCP 工具可能访问外部系统或敏感数据 |
| 对 Shell 输出做验证 | 成功退出不等于行为正确 |

本仓库 `.gitignore` 已默认忽略：

```text
node_modules/
dist/
.npm-cache/
.npm-logs/
.npmrc
.env
.env.*
api.txt
.deepseek/
.codex
.agents/
CLAUDE.md
coverage/
```

---

## 命令速查

### CLI

```text
Usage: seek [options] [command] [prompt...]

Options:
  -m, --model <model>              Model to use
  --mode <mode>                    Interaction mode: plan, agent, yolo
  --api-key <key>                  DeepSeek API key
  --provider <provider>            deepseek, deepseek-cn, nvidia-nim, openrouter, novita, fireworks, sglang
  --base-url <url>                 API base URL
  --max-tokens <n>                 Max tokens per response
  -r, --reasoning-effort <effort>  off, low, medium, high, max, xhigh
  --alt-screen                     Use fullscreen alternate screen
  --no-alt-screen                  Use inline terminal scrollback

Commands:
  serve                            Start the HTTP/SSE server
  config                           Validate, migrate, or explain configuration
```

### Slash Commands

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/plan` | 切换到只读规划模式 |
| `/agent` | 切换到交互批准模式 |
| `/yolo` | 切换到自动执行模式 |
| `/provider [name]` | 查看或切换 provider |
| `/model [name]` | 查看或切换模型 |
| `/capabilities` | 查看当前 provider/model 能力 |
| `/reasoning` | 循环 reasoning effort |
| `/clear` | 清空当前对话和运行时状态 |
| `/save` | 保存当前会话 |
| `/load <id>` | 加载会话 |
| `/delete [id]` | 删除会话 |
| `/sessions` | 列出会话 |
| `/exit` | 保存并退出 |
| `/restore` | 查看 side-git 快照 |
| `/restore revert` | 回滚最近一次 turn |
| `/cost` | 查看成本明细 |
| `/tokens` | 查看上下文 token 使用 |
| `/tasks` | 查看任务状态 |
| `/tasks read <id>` | 查看任务详情 |
| `/tasks cancel <id>` | 取消任务 |
| `/tasks complete <id>` | 标记任务完成 |
| `/jobs` | 查看后台 shell jobs |
| `/jobs show <id>` | 查看 job 输出 |
| `/jobs cancel <id>` | 取消 job |
| `/jobs prune` | 清理旧 job |
| `/mcp list` | 查看 MCP servers |
| `/mcp add <name> <command> [args...]` | 添加 stdio MCP server |
| `/mcp enable <name>` | 启用 MCP server |
| `/mcp disable <name>` | 禁用 MCP server |
| `/mcp remove <name>` | 删除 MCP server |
| `/mcp reload` | 重新加载 MCP |
| `/skills` | 列出本地 skills |
| `/skills --remote` | 查看远端 registry skills |
| `/skill <name>` | 激活 skill |
| `/skill install <spec>` | 安装 skill |
| `/skill update <name>` | 更新 skill |
| `/skill uninstall <name>` | 卸载 skill |
| `/skill trust <name>` | 信任 skill |
| `/permissions` | 查看权限规则 |
| `/config explain` | 解释配置来源 |
| `/config validate` | 校验配置 |
| `/config migrate user` | 迁移用户配置 |
| `/config migrate project` | 迁移项目配置 |
| `/version` | 显示版本 |

---

## License

MIT
