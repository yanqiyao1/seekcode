# Seek Code

<p align="center">
  <img src="./example.png" alt="Seek Code terminal interface preview" width="920">
</p>

<p align="center">
  <strong>DeepSeek-first code agent for serious terminal workflows.</strong>
</p>

<p align="center">
  Plan, inspect, edit, run, verify, restore, and serve your agent runtime from one CLI.
</p>

<p align="center">
  <a href="./README.zh-CN.md"><strong>简体中文</strong></a>
  &nbsp;·&nbsp;
  <a href="#quickstart">Quickstart</a>
  &nbsp;·&nbsp;
  <a href="#feature-overview">Features</a>
  &nbsp;·&nbsp;
  <a href="#module-map">Modules</a>
  &nbsp;·&nbsp;
  <a href="#vs-other-code-clis">Compare</a>
</p>

<p align="center">
  <img alt="DeepSeek First" src="https://img.shields.io/badge/DeepSeek-First-0f172a?style=for-the-badge">
  <img alt="Modes" src="https://img.shields.io/badge/Modes-Plan%20%7C%20Agent%20%7C%20YOLO-16a34a?style=for-the-badge">
  <img alt="Tools" src="https://img.shields.io/badge/Tools-File%20%7C%20Shell%20%7C%20Web%20%7C%20MCP-2563eb?style=for-the-badge">
  <img alt="Server" src="https://img.shields.io/badge/Server-HTTP%20%2B%20SSE-f59e0b?style=for-the-badge">
</p>

<p align="center">
  <code>npm install -g seekcode</code>
  &nbsp;&nbsp;
  <code>seek</code>
  &nbsp;&nbsp;
  <code>seek "review this repo"</code>
</p>

---

## Why Seek Code?

Seek Code is not just a chat wrapper around a model. It is a full agent runtime built for engineering repositories and long terminal sessions.

It is optimized around DeepSeek models, especially `deepseek-v4-pro`, and gives you:

<table>
  <tr>
    <td><strong>Repository-native work</strong></td>
    <td>Read files, write code, apply patches, run commands, search the web, inspect git state, and verify changes without leaving the terminal.</td>
  </tr>
  <tr>
    <td><strong>Operational control</strong></td>
    <td>Switch between <code>plan</code>, <code>agent</code>, and <code>yolo</code> depending on how much autonomy you want.</td>
  </tr>
  <tr>
    <td><strong>Long-running workflows</strong></td>
    <td>Use durable tasks, background jobs, artifacts, session persistence, rollback snapshots, and an HTTP/SSE server.</td>
  </tr>
  <tr>
    <td><strong>Composable ecosystem</strong></td>
    <td>Works with MCP servers, installable skills, sub-agents, diagnostics, and provider-aware DeepSeek deployments.</td>
  </tr>
</table>

---

## Quickstart

### 1. Install

```bash
npm install -g seekcode
```

### 2. Set your API key

```bash
export DEEPSEEK_API_KEY="sk-your-api-key"
```

### 3. Start interactive mode

```bash
seek
```

### 4. Or run one-shot tasks

```bash
seek "summarize this repository"
seek --mode plan "review the current git diff"
seek --model deepseek-v4-pro -r max "design a safe refactor plan"
```

<details>
<summary><strong>Useful first commands</strong></summary>

<br>

<p>
  <kbd>/help</kbd>
  <kbd>/plan</kbd>
  <kbd>/agent</kbd>
  <kbd>/yolo</kbd>
  <kbd>/model</kbd>
  <kbd>/provider</kbd>
  <kbd>/tokens</kbd>
  <kbd>/cost</kbd>
  <kbd>/tasks</kbd>
  <kbd>/jobs</kbd>
  <kbd>/sessions</kbd>
  <kbd>/restore</kbd>
</p>

</details>

---

## Feature Overview

<table>
  <tr>
    <th align="left">Area</th>
    <th align="left">What you can do now</th>
  </tr>
  <tr>
    <td><strong>Interactive coding</strong></td>
    <td>Inspect files, edit code, apply patches, stream tool activity, and keep working in a terminal-native TUI.</td>
  </tr>
  <tr>
    <td><strong>Execution & verification</strong></td>
    <td>Run shell commands, launch background jobs, create verification gates, and trigger diagnostics after code changes.</td>
  </tr>
  <tr>
    <td><strong>Planning & tasking</strong></td>
    <td>Use checklist and plan tools, durable tasks, progress tracking, and structured runtime events for longer engineering work.</td>
  </tr>
  <tr>
    <td><strong>Context & memory</strong></td>
    <td>Persist sessions, keep token/cost visibility, save artifacts, maintain notes, and restore workspace snapshots when needed.</td>
  </tr>
  <tr>
    <td><strong>External knowledge</strong></td>
    <td>Search and fetch the web, plug in MCP servers, and layer project-specific skills on top of the base agent.</td>
  </tr>
  <tr>
    <td><strong>Deployment</strong></td>
    <td>Run as a local CLI or expose the agent as an HTTP/SSE server for threads, sessions, and streaming runtime events.</td>
  </tr>
</table>

---

## Interaction Model

<p align="center">
  <img alt="Plan Mode" src="https://img.shields.io/badge/PLAN-Read--only-64748b?style=flat-square">
  <img alt="Agent Mode" src="https://img.shields.io/badge/AGENT-Approval%20Driven-2563eb?style=flat-square">
  <img alt="YOLO Mode" src="https://img.shields.io/badge/YOLO-Trusted%20Fast%20Execution-f97316?style=flat-square">
</p>

<table>
  <tr>
    <th align="left">Mode</th>
    <th align="left">Behavior</th>
    <th align="left">Best for</th>
  </tr>
  <tr>
    <td><code>plan</code></td>
    <td>Read-only exploration with planning tools.</td>
    <td>Repo onboarding, audits, architecture review, implementation planning.</td>
  </tr>
  <tr>
    <td><code>agent</code></td>
    <td>Read tools auto-run, writes and higher-impact actions require approval.</td>
    <td>Normal development in real repositories.</td>
  </tr>
  <tr>
    <td><code>yolo</code></td>
    <td>Fast execution with broad auto-approval, while still preserving dangerous-tool guardrails.</td>
    <td>Trusted branches, disposable environments, rapid iteration.</td>
  </tr>
</table>

---

## Module Map

<table>
  <tr>
    <th align="left">Module</th>
    <th align="left">Purpose</th>
    <th align="left">Included capabilities</th>
  </tr>
  <tr>
    <td><strong>Terminal UX</strong></td>
    <td>The interactive surface for day-to-day coding.</td>
    <td>TUI, inline/fullscreen modes, status line, live tool activity, picker UI, approvals, command palette.</td>
  </tr>
  <tr>
    <td><strong>Core agent runtime</strong></td>
    <td>The loop that turns prompts into tool-using engineering work.</td>
    <td>Thinking/content streams, runtime events, approvals, context refresh, prompt pinning, cost/token tracking.</td>
  </tr>
  <tr>
    <td><strong>Code & shell tools</strong></td>
    <td>The tools the agent uses inside your workspace.</td>
    <td><code>read</code>, <code>write</code>, <code>edit</code>, <code>apply_patch</code>, <code>search</code>, <code>glob</code>, <code>bash</code>, jobs, verification gates.</td>
  </tr>
  <tr>
    <td><strong>Planning & coordination</strong></td>
    <td>Structure work instead of free-form tool spam.</td>
    <td><code>checklist_write</code>, <code>update_plan</code>, persistent notes, durable tasks, sub-agents, parallel reasoning queries.</td>
  </tr>
  <tr>
    <td><strong>Quality & recovery</strong></td>
    <td>Make change execution safer and easier to inspect.</td>
    <td>Diagnostics, LSP checks, artifacts, rollback snapshots, session restore, task/job visibility.</td>
  </tr>
  <tr>
    <td><strong>Extensibility</strong></td>
    <td>Plug the agent into external systems and project conventions.</td>
    <td>MCP tools, skill discovery/install/trust, provider mapping, local/server runtime support.</td>
  </tr>
</table>

---

## Built For DeepSeek

Seek Code is opinionated: it is designed around DeepSeek as the primary runtime, not as an afterthought compatibility layer.

<table>
  <tr>
    <th align="left">DeepSeek advantage</th>
    <th align="left">Why it matters here</th>
  </tr>
  <tr>
    <td><strong>Large context</strong></td>
    <td>Better repo-wide understanding, longer planning loops, and fewer context resets during real implementation work.</td>
  </tr>
  <tr>
    <td><strong>Thinking-aware streaming</strong></td>
    <td>The TUI can surface longer reasoning turns and live tool progress instead of feeling like a black box.</td>
  </tr>
  <tr>
    <td><strong>Provider portability</strong></td>
    <td>Use the same CLI across DeepSeek, DeepSeek CN, NVIDIA NIM, OpenRouter, Novita, Fireworks, and local SGLang.</td>
  </tr>
  <tr>
    <td><strong>Pro + Flash pairing</strong></td>
    <td>Use <code>deepseek-v4-pro</code> for hard repo work and fast models for lighter fan-out or exploratory tasks.</td>
  </tr>
</table>

---

## Vs Other Code CLIs

This is a positioning table, not a benchmark. The point is to show where Seek Code fits today.

<table>
  <tr>
    <th align="left">CLI</th>
    <th align="left">Primary bias</th>
    <th align="left">Best-known strength</th>
    <th align="left">Where Seek Code differs</th>
  </tr>
  <tr>
    <td><strong>Seek Code</strong></td>
    <td>DeepSeek-first engineering runtime</td>
    <td>Combines terminal coding, task runtime, rollback, artifacts, MCP, and HTTP/SSE serving in one workflow.</td>
    <td>Built specifically to make DeepSeek feel native in serious repo work, with stronger emphasis on planning, runtime observability, and long-lived local workflows.</td>
  </tr>
  <tr>
    <td><strong>Codex CLI</strong></td>
    <td>OpenAI-native terminal coding agent</td>
    <td>Tight alignment with OpenAI tooling and terminal agent workflows.</td>
    <td>Seek Code is more explicitly centered on DeepSeek deployments, multi-mode control, durable tasks, artifacts, and repo recovery flows.</td>
  </tr>
  <tr>
    <td><strong>Claude Code</strong></td>
    <td>Anthropic-native code agent</td>
    <td>Strong reasoning UX, coding assistance, and surrounding ecosystem/docs.</td>
    <td>Seek Code leans harder into DeepSeek model behavior, local server mode, task orchestration, and a more hackable TypeScript runtime.</td>
  </tr>
  <tr>
    <td><strong>OpenCode</strong></td>
    <td>Open and customizable code agent UX</td>
    <td>Open-source flexibility and community-driven iteration.</td>
    <td>Seek Code is more opinionated about DeepSeek-first defaults, operational safety modes, and integrated engineering modules like rollback, artifacts, diagnostics, and MCP lifecycle management.</td>
  </tr>
</table>

<p>
  Reference points:
  <a href="https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started">Codex CLI</a>,
  <a href="https://docs.anthropic.com/en/docs/claude-code/overview">Claude Code</a>,
  <a href="https://opencode.ai/">OpenCode</a>.
</p>

---

## Common Workflows

### Understand a new repository

```bash
seek --mode plan "survey the repo, identify entrypoints, risks, and likely module boundaries"
```

### Make a controlled change

```bash
seek --mode agent "fix the failing tests, explain root cause, make the smallest safe patch, and verify it"
```

### Move fast in a trusted branch

```bash
seek --mode yolo "add regression coverage for the config command and run the relevant tests"
```

### Run as a local agent server

```bash
seek serve --port 8080
```

---

## Extensibility

<table>
  <tr>
    <th align="left">Extension point</th>
    <th align="left">What it gives you</th>
  </tr>
  <tr>
    <td><strong>MCP</strong></td>
    <td>Connect external tools and systems as <code>mcp_*</code> tools, with approval control and lifecycle management.</td>
  </tr>
  <tr>
    <td><strong>Skills</strong></td>
    <td>Inject project conventions, domain playbooks, and repeatable workflows via <code>SKILL.md</code>-based context.</td>
  </tr>
  <tr>
    <td><strong>Sub-agents</strong></td>
    <td>Spawn focused workers for bounded tasks and parallel investigation.</td>
  </tr>
  <tr>
    <td><strong>Artifacts</strong></td>
    <td>Store large logs, patches, diagnostics, and evidence outside the live prompt context.</td>
  </tr>
</table>

---

## Command Snapshot

<details>
<summary><strong>CLI entrypoints</strong></summary>

<br>

```text
seek [prompt...]
seek update
seek serve
seek config
```

</details>

<details>
<summary><strong>Interactive command highlights</strong></summary>

<br>

<table>
  <tr>
    <td><code>/plan</code></td>
    <td>Switch to read-only planning mode</td>
  </tr>
  <tr>
    <td><code>/agent</code></td>
    <td>Switch to approval-driven mode</td>
  </tr>
  <tr>
    <td><code>/yolo</code></td>
    <td>Switch to trusted fast-execution mode</td>
  </tr>
  <tr>
    <td><code>/provider</code> / <code>/model</code></td>
    <td>Change provider or model in-session</td>
  </tr>
  <tr>
    <td><code>/tokens</code> / <code>/cost</code></td>
    <td>Inspect usage and spend</td>
  </tr>
  <tr>
    <td><code>/tasks</code> / <code>/jobs</code></td>
    <td>Inspect durable tasks and background commands</td>
  </tr>
  <tr>
    <td><code>/sessions</code> / <code>/load</code></td>
    <td>Persist and resume conversations</td>
  </tr>
  <tr>
    <td><code>/restore</code></td>
    <td>List and restore workspace snapshots</td>
  </tr>
  <tr>
    <td><code>/skills</code> / <code>/skill</code></td>
    <td>Use or manage skills</td>
  </tr>
  <tr>
    <td><code>/mcp</code></td>
    <td>Manage MCP servers</td>
  </tr>
</table>

</details>

---

## Configuration

Seek Code supports:

<ul>
  <li><strong>Providers:</strong> <code>deepseek</code>, <code>deepseek-cn</code>, <code>nvidia-nim</code>, <code>openrouter</code>, <code>novita</code>, <code>fireworks</code>, <code>sglang</code></li>
  <li><strong>Models:</strong> DeepSeek V4 Pro / Flash and provider-mapped equivalents</li>
  <li><strong>UI modes:</strong> inline scrollback or alternate-screen TUI</li>
  <li><strong>Safety knobs:</strong> approval policy, sandbox rules, diagnostics severity, status items, rollback enablement</li>
</ul>

<details>
<summary><strong>Example config</strong></summary>

<br>

```toml
provider = "deepseek"
model = "deepseek-v4-pro"
flash_model = "deepseek-v4-flash"
mode = "agent"
reasoning_effort = "high"
context_limit = 1000000
approval_policy = "on-request"
sandbox_mode = "workspace-write"
lsp_auto_diagnostics = true
rollback_enabled = true
status_items = ["mode", "model", "workspace", "cache", "tools", "cost", "hints"]
```

</details>

---

## Development

```bash
npm install
npm run build
npm test
```

Node.js `>=22` is required.

---

## License

MIT
