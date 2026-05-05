# Seek Code

<p align="center">
  <strong>A DeepSeek-first code agent for real engineering repositories.</strong>
</p>

<p align="center">
  Built around <code>deepseek-v4-pro</code>, long-context reasoning, terminal-native workflows,
  and the growing DeepSeek ecosystem.
</p>

<p align="center">
  <a href="./README.zh-CN.md"><strong>简体中文</strong></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#quickstart">Quickstart</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#deepseek-first">DeepSeek First</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <a href="#quickstart"><img alt="Quickstart" src="https://img.shields.io/badge/Quickstart-3%20Commands-1677ff?style=for-the-badge"></a>
  <a href="#deepseek-first"><img alt="DeepSeek" src="https://img.shields.io/badge/DeepSeek-V4%20Pro%20First-0f172a?style=for-the-badge"></a>
  <a href="#interaction-modes"><img alt="Modes" src="https://img.shields.io/badge/Modes-Plan%20%7C%20Agent%20%7C%20YOLO-22c55e?style=for-the-badge"></a>
  <a href="#tool-system"><img alt="Tools" src="https://img.shields.io/badge/Tools-File%20Shell%20Git%20Web%20MCP-334155?style=for-the-badge"></a>
</p>

<p align="center">
  <code>npm install -g seekcode</code>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <code>seek</code>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <code>seek "review this repository"</code>
</p>

---

## Table Of Contents

- [What Is Seek Code?](#what-is-seek-code)
- [DeepSeek First](#deepseek-first)
- [Highlights](#highlights)
- [Quickstart](#quickstart)
- [Everyday Workflows](#everyday-workflows)
- [Interaction Modes](#interaction-modes)
- [Terminal Experience](#terminal-experience)
- [Tool System](#tool-system)
- [Configuration](#configuration)
- [Providers And Models](#providers-and-models)
- [MCP Integration](#mcp-integration)
- [Skills And Project Context](#skills-and-project-context)
- [Sessions, Rollback, And Cost](#sessions-rollback-and-cost)
- [HTTP/SSE Server](#httpsse-server)
- [Architecture](#architecture)
- [Development](#development)
- [Safety Model](#safety-model)
- [Command Reference](#command-reference)
- [License](#license)

---

## What Is Seek Code?

Seek Code is a terminal-native code agent designed for real software engineering work. It gives DeepSeek models direct access to your local workspace, so the model can inspect files, edit code, apply patches, run tests, search the web, read Git history, orchestrate sub-agents, and verify its own changes from the terminal.

It is not a thin chat wrapper. Seek Code is an agent runtime with:

- a tool registry for file, shell, Git, web, planning, diagnostics, MCP, and artifact tools;
- interaction modes that control what the agent may do automatically;
- session persistence, rollback snapshots, token/cost tracking, and HTTP/SSE APIs;
- prompt and runtime design centered on decomposition-first engineering work;
- first-class support for DeepSeek V4 models, especially `deepseek-v4-pro`.

The project goal is simple: **make DeepSeek feel like a serious engineering teammate inside your terminal.**

---

## DeepSeek First

Seek Code is intentionally built around the DeepSeek ecosystem.

DeepSeek models are not treated as generic OpenAI-compatible endpoints that happen to work. The CLI is shaped around their strengths: long context, thinking-mode streaming, fast flash-model side queries, cache telemetry, and OpenAI-compatible deployment paths across DeepSeek, DeepSeek CN, NVIDIA NIM, OpenRouter, Novita, Fireworks, and local SGLang.

### Why `deepseek-v4-pro`

`deepseek-v4-pro` is the default model because it is the model this agent wants for serious repository work:

| Capability | Why it matters for a code agent |
|---|---|
| 1M-token context window | The agent can inspect broad project context, long files, logs, diffs, and multi-turn history without constantly losing the thread. |
| Strong reasoning profile | Large refactors, bug hunts, test failures, config migrations, and API design need sustained reasoning, not just local autocomplete. |
| Thinking stream support | Seek Code can surface model thinking events when the provider exposes them, keeping long operations observable. |
| Large output budget | The runtime can handle substantial implementation plans, patch explanations, structured reports, and generated artifacts. |
| Cache telemetry | Token cache information can be surfaced in the UI and cost tracker when supported by the provider. |

In practice, DeepSeek V4 Pro gives Seek Code the room to behave more like an engineer who has actually read the repository: it can survey first, decompose work, maintain context over multiple tool calls, and verify changes before reporting completion.

### DeepSeek V4 Flash

`deepseek-v4-flash` is used as the fast companion model. It is useful for quick one-shot work and for `rlm_query`, where the agent fans out small independent analysis prompts in parallel.

```bash
seek --model deepseek-v4-flash "summarize this module"
```

### Provider-Aware Model Mapping

Seek Code knows how DeepSeek models are named across providers:

- `deepseek-v4-pro`
- `deepseek-v4-flash`
- `deepseek-ai/deepseek-v4-pro`
- `deepseek/deepseek-v4-pro`
- `accounts/fireworks/models/deepseek-v4-pro`
- `deepseek-ai/DeepSeek-V4-Pro`

You can use the same CLI while moving between official DeepSeek APIs, hosted compatible providers, and local SGLang deployments.

---

## Highlights

| Feature | Description |
|---|---|
| DeepSeek-native defaults | Defaults to `deepseek-v4-pro` with DeepSeek-compatible request handling and model capability detection. |
| Three interaction modes | `plan` for read-only exploration, `agent` for approval-driven work, `yolo` for trusted fast execution. |
| Terminal-native TUI | Inline scrollback by default, optional alternate screen, command completion, picker UI, live tool lines. |
| Decomposition-first prompts | The system prompt pushes preview, checklist, plan, recursive decomposition, and verification. |
| Rich tool system | File, shell, Git, web, plan, goal, task, artifact, diagnostic, MCP, sub-agent, and meta tools. |
| Sub-agents and parallel queries | Use `spawn_agent`, `sub_agent`, and `rlm_query` for parallel exploration and implementation. |
| Session persistence | Save, load, list, and delete sessions from the terminal. |
| Workspace rollback | Side-git snapshots let the agent revert recent work without touching your project Git history. |
| HTTP/SSE server | Expose Seek Code as a headless agent server with sessions, threads, tools, skills, and streaming chat. |
| DeepSeek ecosystem expansion | MCP, Skills, provider mapping, SGLang, web tooling, and diagnostics make it useful beyond a single CLI loop. |

---

## Quickstart

### 1. Install

```bash
npm install -g seekcode
```

### 2. Set Your API Key

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
```

### 3. Start The Agent

```bash
seek
```

Inside the interactive session:

```text
read this repository and explain the architecture
```

Useful first commands:

```text
/help
/plan
/model
/tokens
/sessions
```

### One-Shot Mode

If you pass a prompt after the command, Seek Code runs one turn and exits:

```bash
seek "summarize this repository"
seek --mode plan "review the current git diff"
seek -r max "design a careful refactor plan for the engine loop"
```

---

## Everyday Workflows

### Understand A New Repository

```bash
seek --mode plan
```

```text
Survey the repository, identify the entrypoints, explain the module boundaries,
and point out the risky areas before any code changes.
```

`plan` mode is read-only. It is ideal for architecture review, onboarding, audits, and pre-implementation planning.

### Make A Controlled Code Change

```bash
seek --mode agent
```

```text
Fix the failing tests, explain the root cause, make the smallest safe change,
and run the relevant test suite.
```

`agent` mode automatically allows read-only tools, but asks before writes, patches, shell commands, and other higher-impact actions.

### Move Fast In A Trusted Workspace

```bash
seek --mode yolo
```

```text
Add regression tests for the CLI config command and run npm test.
```

`yolo` mode auto-approves most tools. It is best used in disposable branches, clean worktrees, or trusted automation contexts.

### Use DeepSeek V4 Pro For Big Context

```bash
seek --model deepseek-v4-pro -r max
```

```text
Read the runtime, server, and tool registry code. Then propose a design for
making tool activation more adaptive without breaking existing tests.
```

This is the core use case: large codebase context, multi-step reasoning, real tools, and verification.

---

## Interaction Modes

| Mode | Permission behavior | Recommended use |
|---|---|---|
| `plan` | Read-only exploration. Allows file reads, search, glob, Git status/diff/log/branch, web read tools, and planning tools. | Understanding, audits, architecture review, implementation planning. |
| `agent` | Default mode. Read-only tools run automatically; writes, shell, patches, MCP changes, and other impactful tools require approval. | Normal development with human oversight. |
| `yolo` | Auto-approves non-dangerous tools. Dangerous tools still retain protection. | Fast work in trusted, recoverable environments. |

Switch inside the session:

```text
/plan
/agent
/yolo
```

Or press `Shift+Tab`:

```text
plan -> agent -> yolo -> plan
```

---

## Terminal Experience

Seek Code is designed so you can see what the agent is doing instead of waiting on a silent black box.

| Area | Purpose |
|---|---|
| Status line | Current mode, model, workspace, cache, tools, cost, and hints. |
| Transcript | User messages, assistant output, thinking/content separation, and tool results. |
| Tool lines | Compact live feedback for tool start, completion, and preview. |
| Picker UI | Used for model selection, provider selection, session loading, and approval prompts. |
| Input line | Slash commands, Tab completion, multi-byte text navigation, and scroll controls. |

Inline mode is the default:

```bash
seek --no-alt-screen
```

Use full-screen alternate mode when you want a more immersive terminal surface:

```bash
seek --alt-screen
```

Common keys:

| Key | Action |
|---|---|
| `Tab` | Complete slash commands. |
| `Shift+Tab` | Cycle interaction mode. |
| `Esc` | Interrupt the current turn. |
| `Ctrl+C` | Exit. |
| `PageUp` / `PageDown` | Scroll the transcript. |

---

## Tool System

All model actions go through a unified Tool Registry. A tool has a name, description, JSON schema, permission level, category, and parallel-execution metadata.

### Tool Categories

| Category | Representative tools | Purpose |
|---|---|---|
| File | `read`, `write`, `edit`, `ls`, `search`, `glob`, `apply_patch` | Read, inspect, modify, and patch the workspace. |
| Shell | `bash`, `task_shell_start`, `task_shell_wait`, `exec_shell_wait` | Run foreground commands and manage long-running jobs. |
| Git | `git_status`, `git_diff`, `git_log`, `git_branch` | Inspect worktree state and repository history. |
| Web | `web_search`, `web_fetch`, `fetch_url` | Search and fetch external documentation or references. |
| Plan | `checklist_write`, `update_plan`, `plan_status`, `note` | Decompose work and track progress. |
| Goal | `create_goal`, `get_goal`, `update_goal` | Track larger objectives and token budgets. |
| Agent | `spawn_agent`, `sub_agent`, `agent_status` | Run independent sub-agent work. |
| Task | `task_create`, `task_list`, `task_read`, `task_cancel`, `task_complete` | Manage durable task state. |
| Artifact | `artifact_create`, `artifact_list`, `artifact_read`, `artifact_link` | Store large logs, patches, diagnostics, and evidence. |
| Diagnostics | `diagnostics`, `lsp_diagnostics`, GitHub/PR helper tools | Capture quality checks and PR workflow evidence. |
| MCP | `mcp_<server>_<tool>` | Tools provided by external MCP servers. |
| Meta | `think`, `rlm_query`, `tool_search`, `tool_stats`, `tool_enable` | Reasoning, parallel queries, tool discovery, and tool recovery. |

### Adaptive Tool Activation

Seek Code does not need to flood the model with every tool at all times.

- Common read and planning tools are active by default.
- Some tools can be lazily activated when the user request suggests they are relevant.
- Tools that fail repeatedly can be degraded and disabled.
- `tool_search`, `tool_stats`, and `tool_enable` help the agent inspect and recover the tool surface.

### Shell Safety Policy

Shell execution is guarded by a rule-based exec policy:

- safe read commands such as `ls`, `pwd`, `cat`, `grep`, `git diff`, `npm test`, and `npm run build` are allowed by default;
- destructive patterns such as `rm -rf /`, raw block-device writes, `mkfs`, fork bombs, and `chmod -R 777` are denied;
- unknown commands require approval in `agent` mode.

---

## Configuration

Seek Code uses layered configuration. Later sources override earlier sources.

| Priority | Source | Location |
|---|---|---|
| 1 | Built-in defaults | Code defaults |
| 2 | User config | `~/.config/deepseek/config.toml` |
| 3 | Project config | `.deepseek/config.toml` |
| 4 | Environment variables | `DEEPSEEK_*` |
| 5 | CLI flags | `--model`, `--mode`, `--api-key`, etc. |

### Minimal Setup

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
```

### Common Environment Variables

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

### TOML Example

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
# auto uses configured API engines first, then falls back to Bing/DuckDuckGo.
# Supported: auto, brave, tavily, serper, searxng, bing, duckduckgo.
search_engine = "auto"
allowed_domains = []
blocked_domains = []
brave_api_key = ""
tavily_api_key = ""
serper_api_key = ""
searxng_url = ""
proxy = ""
no_proxy = []
search_timeout_ms = 15000
fetch_timeout_ms = 15000
max_bytes = 1000000
```

### Config Commands

```bash
seek config validate
seek config explain
seek config migrate --target user --dry-run
seek config migrate --target project
```

Interactive equivalents:

```text
/config validate
/config explain
/config migrate user --dry-run
/config migrate project
```

---

## Providers And Models

Seek Code is DeepSeek-first, while still supporting OpenAI-compatible DeepSeek deployments across multiple providers.

| Provider | Default base URL | Model mapping |
|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-pro`, `deepseek-v4-flash` |
| `deepseek-cn` | `https://api.deepseeki.com` | Same DeepSeek model names |
| `nvidia-nim` | `https://integrate.api.nvidia.com/v1` | Maps to `deepseek-ai/...` |
| `openrouter` | `https://openrouter.ai/api/v1` | Maps to `deepseek/...` |
| `novita` | `https://api.novita.ai/v1` | Maps to `deepseek/...` |
| `fireworks` | `https://api.fireworks.ai/inference/v1` | Maps to `accounts/fireworks/models/...` |
| `sglang` | `http://localhost:30000/v1` | Maps to `deepseek-ai/DeepSeek-V4-*` |

Provider examples:

```bash
seek --provider deepseek --model deepseek-v4-pro
seek --provider openrouter --api-key "$OPENROUTER_API_KEY"
seek --provider sglang --base-url http://localhost:30000/v1
```

Interactive model and provider controls:

```text
/provider
/provider deepseek
/provider sglang
/model
/model deepseek-v4-flash
/capabilities
```

Reasoning effort:

```bash
seek -r off "summarize this file"
seek -r high "implement this change carefully"
seek -r max "design a migration plan"
```

Interactive cycle:

```text
/reasoning
```

Cycle order:

```text
off -> low -> medium -> high -> max -> xhigh -> off
```

---

## MCP Integration

Seek Code supports Model Context Protocol. On startup, configured MCP servers are connected and their tools are registered as:

```text
mcp_<server_name>_<tool_name>
```

### Example

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

### Interactive Management

```text
/mcp list
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp
/mcp enable filesystem
/mcp disable filesystem
/mcp remove filesystem
/mcp reload
```

MCP tools require approval by default. This makes them appropriate for GitHub, filesystem, database, internal platform, and documentation integrations.

---

## Skills And Project Context

### Skills

Skills inject domain knowledge, repository conventions, and repeatable workflows into the agent. Each skill is described by a `SKILL.md` file:

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

Useful commands:

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

Place `AGENTS.md` at the repository root to provide project instructions:

```markdown
# Project Instructions

- Use TypeScript strict mode.
- Keep public CLI behavior backward compatible.
- Prefer focused tests for regression fixes.
```

Seek Code injects these instructions into the system prompt, so the agent can follow local conventions while editing.

---

## Sessions, Rollback, And Cost

### Session Persistence

```text
/save
/sessions
/load <session_id>
/delete <session_id>
/exit
```

Default session location:

```text
~/.local/share/deepseek/sessions
```

Override:

```bash
export DEEPSEEK_SESSIONS_DIR="/path/to/sessions"
```

### Workspace Rollback

Seek Code uses side-git snapshots for turn-level workspace recovery without modifying your project Git history:

```text
.deepseek/side-git
```

List snapshots:

```text
/restore
```

Revert the latest turn:

```text
/restore revert
```

### Token And Cost Tracking

```text
/tokens
/cost
```

`/tokens` shows context usage and capacity decisions. `/cost` shows per-turn and cumulative token/cost information.

### Artifacts

Large logs, diagnostics, patches, and PR evidence can be stored as artifacts instead of flooding model context:

```text
artifact_create
artifact_list
artifact_read
artifact_link
artifact_links
```

Default artifact location:

```text
~/.local/share/deepseek/artifacts
```

Override:

```bash
export DEEPSEEK_ARTIFACTS_DIR="/path/to/artifacts"
export DEEPCODE_ARTIFACTS_DIR="/path/to/artifacts"
```

---

## HTTP/SSE Server

Run Seek Code as a headless agent server:

```bash
seek serve --host 0.0.0.0 --port 8080
```

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Health check |
| `POST` | `/v1/session` | Create a session and thread |
| `GET` | `/v1/session/:session_id` | Get a session |
| `GET` | `/v1/sessions` | List runtime sessions |
| `DELETE` | `/v1/sessions/:session_id` | Delete a session |
| `POST` | `/v1/session/:session_id/chat` | Run one streaming chat turn |
| `GET` | `/v1/tools` | List tools |
| `GET` | `/v1/skills` | List skills |
| `GET` | `/v1/threads` | List threads |
| `POST` | `/v1/threads` | Create a thread |
| `GET` | `/v1/threads/:thread_id` | Get thread details |
| `PATCH` | `/v1/threads/:thread_id` | Update a thread |
| `POST` | `/v1/threads/:thread_id/fork` | Fork a thread |
| `GET` | `/v1/threads/:thread_id/events` | Fetch or subscribe to events |
| `GET` | `/v1/threads/:thread_id/items` | Fetch runtime items |
| `POST` | `/v1/threads/:thread_id/turns/:turn_id/interrupt` | Interrupt a turn |

### Example

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

SSE events:

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

## Architecture

### Runtime Flow

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

### Source Layout

```text
src/
  index.ts                 CLI entrypoint, interactive loop, slash commands
  config.ts                TOML, env vars, CLI overrides, validation

  client/
    base.ts                Model client interface and StreamEvent types
    capabilities.ts        Provider/model capability matrix
    deepseek.ts            OpenAI-compatible DeepSeek client wrapper
    streaming.ts           Stream accumulation helpers

  engine/
    loop.ts                Core ReAct-style execution loop
    context.ts             System prompt and tool description assembly
    compact.ts             Context compaction strategy
    context-manager.ts     Context refresh and capacity management
    skills.ts              Skill discovery, install, trust, injection
    agents-md.ts           AGENTS.md injection
    hooks.ts               Lifecycle hooks
    task-lifecycle.ts      Task lifecycle tracking

  tools/
    base.ts                ToolDef, permission levels, OpenAI schema conversion
    registry.ts            Global tool registry
    file-ops.ts            File read/write/search/glob tools
    shell.ts               Shell and background jobs
    exec-policy.ts         Shell safety policy
    git.ts                 Git read tools
    web.ts                 Web search and fetch tools
    patch.ts               apply_patch wrapper
    patch-advanced.ts      Patch parser
    plan.ts                Checklist, plan, note
    goal.ts                Goal and token budget tracking
    sub-agent.ts           Sub-agent orchestration
    rlm-query.ts           Parallel lightweight model queries
    tasks.ts               Task management
    artifacts.ts           Artifact tools
    diagnostics.ts         Diagnostics and PR workflow helpers

  tui/
    layout.ts              Terminal layout
    transcript.ts          Conversation transcript
    assistant-stream.ts    Model output stream rendering
    tool-lines.ts          Tool execution lines
    screen.ts              Screen primitives

  ui/
    input.ts               Raw-mode input, completion, shortcuts
    renderer.ts            Terminal renderer
    markdown.ts            Markdown rendering
    palette.ts             Color palette
    picker.ts              Picker UI

  session/
    types.ts               Session/message/turn types
    history.ts             Conversation history
    store.ts               JSON persistence
    title.ts               Session title generation

  server/
    app.ts                 Hono app and routes
    handlers.ts            HTTP/SSE handlers
    runtime-store.ts       Server runtime state
    transport.ts           SSE transport

  mcp/
    protocol.ts            JSON-RPC/MCP types
    client.ts              stdio and SSE MCP client
    manager.ts             MCP lifecycle and tool registration

  rollback/
    side-git.ts            Side-git snapshots
    restore.ts             Restore entrypoint

  cost/
    pricing.ts             Pricing table
    tracker.ts             Token and cost tracking
```

### Turn Lifecycle

1. The user submits a natural-language task.
2. The CLI builds context from config, workspace, tools, skills, and project instructions.
3. The engine calls the DeepSeek-compatible client and streams thinking, content, and tool calls.
4. The mode checks whether each tool call is allowed.
5. Tool results are appended to history and may produce runtime items or artifacts.
6. The engine iterates until the model returns a final response.
7. Session, cost, turn, and rollback state are updated.

---

## Development

### Requirements

- Node.js `>= 22`
- npm
- A DeepSeek API key or compatible provider API key

### Run From Source

```bash
git clone <repo-url>
cd seekcode
npm install
npm run build
npm link
seek --version
```

Development mode:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

`npm test` runs `npm run build` first, so the test suite validates both the source entrypoint and the generated `dist/index.js` entrypoint.

### Test Layout

| File | Focus |
|---|---|
| `client-regression.test.ts` | Client behavior, streaming parsing, provider behavior |
| `cli-regression.test.ts` | CLI flags, help/version, interactive startup, dist entrypoint |
| `modes-regression.test.ts` | Plan/agent/yolo permission behavior |
| `runtime-regression.test.ts` | Runtime, tasks, shell behavior |
| `server-regression.test.ts` | HTTP/SSE server |
| `session-regression.test.ts` | Session save/load/list/delete |
| `tools-regression.test.ts` | File, patch, Git, skills, MCP, artifact, diagnostics tools |
| `ui.test.ts` | Input, rendering, layout, Markdown, picker |
| `web-regression.test.ts` | Web search/fetch, safety restrictions, proxy config |

---

## Safety Model

Seek Code can modify files, run commands, and access the network. Choose the right mode for the work.

| Recommendation | Reason |
|---|---|
| Start unknown repositories with `--mode plan` | Understand before changing anything. |
| Use `agent` mode for important repositories | Keep approval before writes, shell, and patches. |
| Use `yolo` only in trusted and recoverable workspaces | It is fast because it removes friction. |
| Keep Git enabled and inspect diffs | Reviewability is your strongest safety layer. |
| Do not store real secrets in project files | `.env`, `api.txt`, and `.npmrc` should stay ignored. |
| Treat MCP servers as powerful integrations | They may access external systems or sensitive data. |
| Verify shell output, not just exit codes | A successful command does not always mean a correct result. |

This repository ignores common local and sensitive files:

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

## Command Reference

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

| Command | Description |
|---|---|
| `/help` | Show help |
| `/plan` | Switch to read-only planning mode |
| `/agent` | Switch to approval-driven agent mode |
| `/yolo` | Switch to auto-execution mode |
| `/provider [name]` | Show or switch provider |
| `/model [name]` | Show or switch model |
| `/capabilities` | Show current provider/model capabilities |
| `/reasoning` | Cycle reasoning effort |
| `/clear` | Clear conversation and runtime state |
| `/save` | Save current session |
| `/load <id>` | Load a session |
| `/delete [id]` | Delete a session |
| `/sessions` | List sessions |
| `/exit` | Save and exit |
| `/restore` | List side-git snapshots |
| `/restore revert` | Revert the latest turn |
| `/cost` | Show cost breakdown |
| `/tokens` | Show context token usage |
| `/tasks` | Show task status |
| `/tasks read <id>` | Read task details |
| `/tasks cancel <id>` | Cancel a task |
| `/tasks complete <id>` | Mark a task complete |
| `/jobs` | Show background shell jobs |
| `/jobs show <id>` | Show job output |
| `/jobs cancel <id>` | Cancel a job |
| `/jobs prune` | Prune old jobs |
| `/mcp list` | List MCP servers |
| `/mcp add <name> <command> [args...]` | Add a stdio MCP server |
| `/mcp enable <name>` | Enable an MCP server |
| `/mcp disable <name>` | Disable an MCP server |
| `/mcp remove <name>` | Remove an MCP server |
| `/mcp reload` | Reload MCP servers |
| `/skills` | List local skills |
| `/skills --remote` | Browse remote registry skills |
| `/skill <name>` | Activate a skill |
| `/skill install <spec>` | Install a skill |
| `/skill update <name>` | Update a skill |
| `/skill uninstall <name>` | Uninstall a skill |
| `/skill trust <name>` | Trust a skill |
| `/permissions` | Show permission rules |
| `/config explain` | Explain config sources |
| `/config validate` | Validate config |
| `/config migrate user` | Migrate user config |
| `/config migrate project` | Migrate project config |
| `/version` | Show version |

---

## License

MIT
