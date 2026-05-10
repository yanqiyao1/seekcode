# Seek Code

Seek Code 是一个专为 DeepSeek 打造的终端 Code Agent。它不是通用聊天壳，而是围绕 `deepseek-v4-pro` / `deepseek-v4-flash`、长上下文、工具调用、工程验证和本地安全策略设计的一整套开发运行时。

```bash
npm install -g seekcode
export DEEPSEEK_API_KEY="sk-your-api-key"
seek
```

Node.js 需要 `>=22`。

## 为什么专为 DeepSeek

- 默认模型是 `deepseek-v4-pro`，默认 fast model 是 `deepseek-v4-flash`。
- 默认上下文、reasoning、流式 thinking、工具循环和 token/cost 统计都按 DeepSeek 工作方式调优。
- 支持 DeepSeek 官方、DeepSeek CN、NVIDIA NIM、OpenRouter、Novita、Fireworks、SGLang 等 DeepSeek 部署方式。
- CLI、TUI、权限、MCP、Skills、任务、回滚和 Server 能力都围绕“在真实仓库里长时间工作”设计。

## 快速使用

交互式开发：

```bash
seek
```

一次性任务：

```bash
seek "review the current diff and suggest the smallest safe fix"
seek --mode plan "survey this repo and explain the architecture"
seek --mode agent "fix the failing tests and run the relevant verification"
seek --mode yolo "format the repo and run the full test suite"
```

切换模型、provider 和 reasoning：

```bash
seek --model deepseek-v4-pro -r high
seek --provider deepseek-cn
seek --provider sglang --base-url http://localhost:30000/v1 --model deepseek-v4-pro
```

运行本地 HTTP/SSE Agent Server：

```bash
seek serve --host 127.0.0.1 --port 8080
```

检查或升级：

```bash
seek update --check
seek update -y
```

## 已支持的完整功能

| 能力 | 支持内容 | 常用方式 |
|---|---|---|
| 交互式 TUI | inline scrollback、fullscreen、状态栏、实时工具状态、审批弹窗、Tab 补全 | `seek`、`--alt-screen`、`--no-alt-screen` |
| 模式控制 | `plan` 只读规划、`agent` 审批驱动、`yolo` 高信任快速执行 | `--mode plan`、`/agent`、`/yolo` |
| 代码工具 | 读写文件、搜索、glob、patch、编辑、Git 状态和 diff | 直接描述任务，Agent 自动调用工具 |
| Shell 与验证 | 前台命令、后台 jobs、等待/取消、verification gate、LSP diagnostics | `/jobs`、让 Agent “run tests” |
| Web | 搜索和抓取 URL，支持多搜索源、域名 allow/block、代理 | 让 Agent “search web”、配置 `[web]` |
| MCP | stdio/SSE MCP Server，工具自动注册为 `mcp_*` | `/mcp add ...`、`/mcp reload` |
| Skills | `SKILL.md` 工作流、安装、更新、信任、项目/全局发现 | `/skills`、`/skill <name>` |
| 任务系统 | durable tasks、checklist、plan、notes、长任务状态 | `/tasks`、Agent 工具 `task_create` |
| Artifacts | 保存长日志、诊断、patch、证据，避免污染上下文 | Agent 自动创建，或使用 artifact 工具 |
| Sessions | 会话保存、加载、删除、恢复工作区上下文 | `/save`、`/sessions`、`/load` |
| 回滚 | workspace snapshot，支持查看和恢复 | `/restore` |
| 子 Agent | bounded worker、并行调查、状态查询 | Agent 工具 `spawn_agent` |
| Server | HTTP/SSE threads、sessions、runtime events、skills API | `seek serve` |

## 常用功能示例

模式与上下文：

```text
/plan                 # 切到只读规划
/agent                # 切到常规开发模式
/yolo                 # 切到高信任快速执行
/tokens               # 查看 token 使用
/cost                 # 查看成本
/clear                # 清空当前上下文
```

会话与恢复：

```text
/save                 # 保存当前会话
/sessions             # 列出会话
/load <session-id>    # 加载会话
/delete <session-id>  # 删除会话
/restore              # 查看并恢复 workspace snapshot
```

MCP：

```text
/mcp list
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
/mcp disable filesystem
/mcp reload
```

也可以写进配置文件：

```toml
[[mcp_servers]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
enabled = true
```

Skills：

```text
/skills                       # 查看本地 skills
/skills remote                # 查看远程 registry
/skill install github:org/repo
/skill trust my-skill
/skill my-skill               # 下一轮使用这个 skill
```

配置诊断：

```bash
seek config validate
seek config explain
seek config migrate --target user
seek config migrate --target project --dry-run
```

## 配置与默认路径

配置优先级：

```text
默认值 < 用户配置 < 项目配置 < 环境变量 < CLI 参数
```

| 内容 | 默认位置 | 如何更改 |
|---|---|---|
| 用户配置 | `~/.seekcode/config.toml` | 直接编辑文件，或用环境变量/CLI 覆盖 |
| 项目配置 | `./.seekcode/config.toml` | 放在当前仓库，覆盖用户配置 |
| Sessions | `${XDG_DATA_HOME:-~/.local/share}/seekcode/sessions` | `SEEKCODE_SESSIONS_DIR=/path` |
| Artifacts | `${XDG_DATA_HOME:-~/.local/share}/seekcode/artifacts` | `SEEKCODE_ARTIFACTS_DIR=/path` |
| Tasks | `${XDG_DATA_HOME:-~/.local/share}/seekcode/tasks/tasks.json` | `SEEKCODE_TASKS_DIR=/path` |
| Jobs | `${XDG_DATA_HOME:-~/.local/share}/seekcode/jobs` | `SEEKCODE_JOBS_DIR=/path` |
| Runtime Server 数据 | `${XDG_DATA_HOME:-~/.local/share}/seekcode/runtime` | `SEEKCODE_RUNTIME_DIR=/path` |
| 全局 Skills | `~/.seekcode/skills` | 配置 `skills_dir` 或 `DEEPSEEK_SKILLS_DIR` |
| 项目 Skills | `./.seekcode/skills`、`./skills`、`./.agents/skills` | 放入这些目录即可被发现 |
| 回滚快照 | `./.seekcode/side-git` | workspace-local，随仓库目录变化 |

常用配置示例：

```toml
api_key = ""
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
flash_model = "deepseek-v4-flash"

mode = "agent"
reasoning_effort = "high"
max_tokens = 8192
context_limit = 1000000

approval_policy = "on-request"
sandbox_mode = "workspace-write"
workspace_boundary = true
rollback_enabled = true
lsp_auto_diagnostics = true
status_items = ["mode", "model", "workspace", "cache", "tools", "cost", "hints"]

[web]
enabled = true
mode = "live"
search_engine = "auto"
allowed_domains = []
blocked_domains = []
```

常用环境变量：

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEEPSEEK_MODEL="deepseek-v4-pro"
export DEEPSEEK_PROVIDER="deepseek"
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
export DEEPSEEK_REASONING_EFFORT="high"
export DEEPSEEK_TUI_ALTERNATE_SCREEN="never"
export XDG_DATA_HOME="$HOME/.local/share"
```

## 兼容性说明

Seek Code 保持 DeepSeek-first 的默认体验，同时尽量兼容现有 Code Agent 生态：

- 原生读取 `AGENTS.md`，并支持分层项目指令。
- 兼容 Claude Code 指令文件：`CLAUDE.md`、`.claude/CLAUDE.md`。
- 兼容 Claude Code markdown slash commands：发现项目和用户目录下的 `.claude/commands/**/*.md`，以 `/project:name` 或 `/user:name` 形式使用。
- Skills 会扫描 `./.seekcode/skills`、`./skills`、`./.agents/skills`、`~/.seekcode/skills`，也兼容 `~/.agents/skills`、`~/.claude/skills`、`.deepseek/skills`。
- MCP 使用通用 stdio/SSE server 配置，现有 MCP Server 通常可以直接接入。
- 支持从旧 `.deepseek` 配置迁移：`seek config migrate --target user|project`。
- 兼容性不会改变 Seek Code 的权限、sandbox 和 DeepSeek-first 工具策略；外部指令只作为项目上下文和命令扩展进入系统。

## 开发

```bash
npm install
npm run build
npm test
```

## License

MIT
