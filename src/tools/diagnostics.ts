/** Diagnostics, GitHub context, PR attempt, automation, and MCP manager helpers. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { createArtifact, getArtifact, listArtifacts, readArtifact } from "../artifacts/store.js";
import { addMCPServer, getMCPManager, reloadMCPManager, removeMCPServer, setMCPServerEnabled } from "../mcp/manager.js";
import type { MCPConfig } from "../config.js";

function run(command: string, workdir = "."): string {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return `Error: ${result.error.message}`;
  return (result.stdout || result.stderr || "").trim() || `(exit ${result.status ?? "unknown"})`;
}

function runRaw(command: string, workdir = "."): string {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return `Error: ${result.error.message}`;
  return [result.stdout, result.stderr].filter(Boolean).join("").trim();
}

function runWithStatus(command: string, workdir = "."): { output: string; status: number | null; error?: string } {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return { output: `Error: ${result.error.message}`, status: null, error: result.error.message };
  return { output: [result.stdout, result.stderr].filter(Boolean).join("").trim(), status: result.status ?? null };
}

async function diagnostics(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const info = {
    cwd: resolve(workdir),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    git: run("git status --short 2>&1", workdir),
    tools: getRegistry().listAll().map(tool => ({ name: tool.name, category: tool.category, active: getRegistry().listActive().some(active => active.name === tool.name) })),
  };
  return JSON.stringify(info, null, 2);
}

async function githubIssueContext(args: Record<string, unknown>): Promise<string> {
  const issue = String(args.issue || args.number || args.url || "");
  if (!issue) return "Error: issue, number, or url is required.";
  const output = run(`gh issue view ${JSON.stringify(issue)} --json number,title,state,author,body,url,comments`, String(args.workdir || "."));
  const artifact = createArtifact({ kind: "github_issue", name: `issue-${safeName(issue)}.json`, content: output, extension: ".json", metadata: { issue } });
  return withArtifact(output, artifact.id);
}

async function githubPrContext(args: Record<string, unknown>): Promise<string> {
  const pr = String(args.pr || args.number || args.url || "");
  if (!pr) return "Error: pr, number, or url is required.";
  const includeDiff = args.diff === true;
  const base = run(`gh pr view ${JSON.stringify(pr)} --json number,title,state,author,body,url,comments,headRefName,baseRefName`, String(args.workdir || "."));
  const output = includeDiff ? `${base}\n\n[diff]\n${run(`gh pr diff ${JSON.stringify(pr)} --patch`, String(args.workdir || "."))}` : base;
  const artifact = createArtifact({ kind: "github_pr", name: `pr-${safeName(pr)}.${includeDiff ? "txt" : "json"}`, content: output, metadata: { pr, includeDiff } });
  return withArtifact(output, artifact.id);
}

async function githubComment(args: Record<string, unknown>): Promise<string> {
  const target = String(args.issue || args.pr || args.number || args.url || "");
  const body = String(args.body || "");
  if (!target || !body) return "Error: target and body are required.";
  const guard = githubMutationGuard(args, { requireClean: args.allow_dirty !== true });
  if (guard) return guard;
  const evidence = verifyGithubTarget(target, String(args.workdir || "."));
  if (evidence.startsWith("Error:")) return evidence;
  const artifact = createArtifact({ kind: "github_evidence", name: `comment-${safeName(target)}.json`, content: evidence, extension: ".json", metadata: { target, action: "comment" } });
  return run(`gh issue comment ${JSON.stringify(target)} --body ${JSON.stringify(body)}`, String(args.workdir || "."));
}

async function githubCloseIssue(args: Record<string, unknown>): Promise<string> {
  const issue = String(args.issue || args.number || args.url || "");
  const reason = String(args.reason || "");
  if (!issue || !reason.trim()) return "Error: issue and reason are required.";
  const guard = githubMutationGuard(args, { requireClean: args.allow_dirty !== true });
  if (guard) return guard;
  const evidence = verifyGithubTarget(issue, String(args.workdir || "."));
  if (evidence.startsWith("Error:")) return evidence;
  createArtifact({ kind: "github_evidence", name: `close-${safeName(issue)}.json`, content: evidence, extension: ".json", metadata: { issue, action: "close" } });
  return run(`gh issue close ${JSON.stringify(issue)} --comment ${JSON.stringify(reason)}`, String(args.workdir || "."));
}

const ATTEMPT_DIR = join(tmpdir(), "seek-code-pr-attempts");

async function prAttemptRecord(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const id = `attempt_${Date.now().toString(36)}`;
  const patch = runRaw("git diff --binary", workdir);
  const status = runRaw("git status --porcelain=v1", workdir);
  const branch = runRaw("git branch --show-current 2>&1", workdir);
  const artifact = createArtifact({ kind: "pr_attempt", name: `${id}.patch`, content: patch, extension: ".patch", metadata: { id, workdir: resolve(workdir), status, branch } });
  return JSON.stringify({ id, artifact_id: artifact.id, file: artifact.path, bytes: patch.length, sha256: artifact.sha256, branch, status }, null, 2);
}

async function prAttemptList(): Promise<string> {
  const artifacts = listArtifacts(100, "pr_attempt");
  const legacy = existsSync(ATTEMPT_DIR) ? readdirSync(ATTEMPT_DIR).filter(name => name.endsWith(".patch")).map(name => ({ legacy: name.replace(/\.patch$/, "") })) : [];
  if (!artifacts.length && !legacy.length) return "No PR attempts.";
  return JSON.stringify({ artifacts, legacy }, null, 2);
}

async function prAttemptRead(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || "").replace(/\.patch$/, "");
  if (!id) return "Error: id is required.";
  const artifact = getArtifact(id);
  if (artifact) return readArtifact(id);
  const file = join(ATTEMPT_DIR, `${id}.patch`);
  return existsSync(file) ? readFileSync(file, "utf-8") : `Error: attempt not found: ${id}`;
}

async function prAttemptPreflight(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || "").replace(/\.patch$/, "");
  if (!id) return "Error: id is required.";
  const artifact = getArtifact(id);
  const file = artifact?.path || join(ATTEMPT_DIR, `${id}.patch`);
  if (!existsSync(file)) return `Error: attempt not found: ${id}`;
  return run(`git apply --check ${JSON.stringify(file)}`, String(args.workdir || "."));
}

async function prAttemptBranch(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const name = String(args.branch || `seek-code/${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9._/-]/g, "-");
  const base = args.base ? String(args.base) : "";
  const guard = ensureGitRepo(workdir);
  if (guard) return guard;
  const output = run(`git checkout ${base ? JSON.stringify(base) : ""} -b ${JSON.stringify(name)} 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_attempt_branch", name: `${safeName(name)}.txt`, content: output, metadata: { workdir: resolve(workdir), branch: name, base } });
  return JSON.stringify({ branch: name, artifact_id: artifact.id, output }, null, 2);
}

async function prAttemptGate(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const command = String(args.command || args.gate || "");
  if (!command) return "Error: command is required.";
  const result = runWithStatus(command, workdir);
  const passed = result.status === 0;
  const output = result.output || `(exit ${result.status ?? "unknown"})`;
  const artifact = createArtifact({ kind: "pr_attempt_gate", name: "gate.log", content: output, extension: ".log", metadata: { workdir: resolve(workdir), command, passed, status: result.status } });
  return JSON.stringify({ command, passed, status: result.status, artifact_id: artifact.id, output }, null, 2);
}

async function prAttemptPushDraft(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const title = String(args.title || "Seek Code draft PR");
  const body = String(args.body || "Created by Seek Code.");
  const branch = String(args.branch || run("git branch --show-current", workdir)).trim();
  if (!branch) return "Error: branch is required or current branch cannot be detected.";
  const guard = githubMutationGuard(args, { requireClean: args.allow_dirty !== true });
  if (guard) return guard;
  const push = run(`git push -u origin ${JSON.stringify(branch)} 2>&1`, workdir);
  const create = run(`gh pr create --draft --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_attempt_push", name: `${safeName(branch)}.log`, content: `${push}\n\n${create}`, extension: ".log", metadata: { workdir: resolve(workdir), branch, title } });
  return JSON.stringify({ branch, artifact_id: artifact.id, push, create }, null, 2);
}

async function prAttemptReviewSync(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const pr = String(args.pr || args.number || args.url || "");
  if (!pr) return "Error: pr, number, or url is required.";
  if (!commandExists("gh")) return "Error: GitHub CLI 'gh' is required.";
  const comments = run(`gh pr view ${JSON.stringify(pr)} --json comments,reviews,reviewDecision,url 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_review_comments", name: `pr-${safeName(pr)}-review.json`, content: comments, extension: ".json", metadata: { workdir: resolve(workdir), pr } });
  return JSON.stringify({ pr, artifact_id: artifact.id, comments }, null, 2);
}

async function prAttemptRollback(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const branch = String(args.branch || "");
  const target = String(args.target || "HEAD");
  const guard = ensureGitRepo(workdir);
  if (guard) return guard;
  const before = run("git status --porcelain=v1 && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD", workdir);
  const output = branch
    ? run(`git checkout ${JSON.stringify(branch)} 2>&1 && git reset --hard ${JSON.stringify(target)} 2>&1`, workdir)
    : run(`git reset --hard ${JSON.stringify(target)} 2>&1`, workdir);
  const after = run("git status --porcelain=v1 && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD", workdir);
  const artifact = createArtifact({ kind: "pr_attempt_rollback", name: "rollback.log", content: `[before]\n${before}\n\n[output]\n${output}\n\n[after]\n${after}`, extension: ".log", metadata: { workdir: resolve(workdir), branch, target } });
  return JSON.stringify({ branch: branch || null, target, artifact_id: artifact.id, output }, null, 2);
}

interface Automation {
  id: string;
  prompt: string;
  schedule?: string;
  paused: boolean;
  created_at: string;
}

const automations = new Map<string, Automation>();

async function automationCreate(args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt || "");
  if (!prompt.trim()) return "Error: prompt is required.";
  const automation: Automation = {
    id: `auto_${Date.now().toString(36)}`,
    prompt,
    schedule: args.schedule ? String(args.schedule) : undefined,
    paused: false,
    created_at: new Date().toISOString(),
  };
  automations.set(automation.id, automation);
  return JSON.stringify(automation, null, 2);
}

async function automationList(): Promise<string> {
  return JSON.stringify([...automations.values()], null, 2);
}

async function automationRead(args: Record<string, unknown>): Promise<string> {
  const automation = automations.get(String(args.id || ""));
  return automation ? JSON.stringify(automation, null, 2) : `Error: automation not found: ${args.id}`;
}

async function automationUpdate(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || "");
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  if (args.prompt !== undefined) automation.prompt = String(args.prompt);
  if (args.schedule !== undefined) automation.schedule = String(args.schedule);
  return JSON.stringify(automation, null, 2);
}

async function automationStatus(args: Record<string, unknown>, paused: boolean): Promise<string> {
  const id = String(args.id || "");
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  automation.paused = paused;
  return JSON.stringify(automation, null, 2);
}

async function automationDelete(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || "");
  return automations.delete(id) ? `Deleted automation ${id}.` : `Error: automation not found: ${id}`;
}

async function automationRun(args: Record<string, unknown>): Promise<string> {
  const automation = automations.get(String(args.id || ""));
  if (!automation) return `Error: automation not found: ${args.id}`;
  const { getTaskManager } = await import("../engine/task-lifecycle.js");
  const task = getTaskManager().createTask("background", `Automation: ${automation.prompt}`);
  getTaskManager().startTask(task.id);
  return JSON.stringify({ task_id: task.id, automation }, null, 2);
}

async function mcpManager(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action || "list");
  try {
    if (action === "list") return JSON.stringify(getMCPManager().list(), null, 2);
    if (action === "reload") {
      const manager = await reloadMCPManager();
      return JSON.stringify({ reloaded: true, servers: manager.list() }, null, 2);
    }
    if (action === "health") {
      const name = args.name ? String(args.name) : undefined;
      return JSON.stringify(await getMCPManager().healthCheck(name), null, 2);
    }
    if (action === "reconnect") {
      const name = String(args.name || "");
      if (!name) return "Error: name is required.";
      const server = getMCPManager().list().find(item => item.name === name);
      if (!server) return `Error: MCP server not found: ${name}`;
      return await getMCPManager().connectOne(server);
    }
    if (action === "add") {
      const server = parseMCPServer(args);
      const servers = addMCPServer(server);
      return JSON.stringify({ added: server.name, servers }, null, 2);
    }
    if (action === "enable" || action === "disable") {
      const name = String(args.name || "");
      if (!name) return "Error: name is required.";
      const servers = setMCPServerEnabled(name, action === "enable");
      return JSON.stringify({ name, enabled: action === "enable", servers }, null, 2);
    }
    if (action === "remove" || action === "delete") {
      const name = String(args.name || "");
      if (!name) return "Error: name is required.";
      const servers = removeMCPServer(name);
      return JSON.stringify({ removed: name, servers }, null, 2);
    }
    return `Error: unsupported MCP action '${action}'. Use list, add, enable, disable, remove, reload, health, reconnect.`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function lspDiagnostics(args: Record<string, unknown>): Promise<string> {
  const workdir = String(args.workdir || ".");
  const language = String(args.language || detectLanguage(workdir));
  const files = normalizeFiles(args.files);
  const minSeverity = String(args.min_severity || args.severity || "all");
  const command = diagnosticCommand(language, workdir);
  if (!command) return `Error: unsupported language '${language}'. Supported: typescript, python, go, rust.`;
  const output = run(command, workdir);
  const diagnostics = filterDiagnostics(parseDiagnostics(output, language), { files, minSeverity, workdir });
  const summary = summarizeDiagnostics(diagnostics);
  const artifact = createArtifact({
    kind: "lsp_diagnostics",
    name: `${language}-diagnostics.txt`,
    content: output,
    metadata: { language, workdir: resolve(workdir), command, files, min_severity: minSeverity, summary },
  });
  return JSON.stringify({ language, command, artifact_id: artifact.id, summary, diagnostics, output }, null, 2);
}

export async function runAutoDiagnostics(args: {
  workdir: string;
  files?: string[];
  minSeverity?: string;
}): Promise<string> {
  const result = await lspDiagnostics({
    workdir: args.workdir,
    files: args.files || [],
    min_severity: args.minSeverity || "warning",
  });
  try {
    const parsed = JSON.parse(result);
    const summary = parsed.summary as { total?: number; by_severity?: Record<string, number> };
    const total = Number(summary?.total || 0);
    if (!total) return `Diagnostics: no issues found. Artifact: ${parsed.artifact_id}`;
    const counts = Object.entries(summary.by_severity || {})
      .map(([severity, count]) => `${severity}:${count}`)
      .join(" ");
    const first = Array.isArray(parsed.diagnostics) && parsed.diagnostics.length
      ? ` First: ${formatDiagnostic(parsed.diagnostics[0])}`
      : "";
    return `Diagnostics: ${total} issue(s) ${counts}. Artifact: ${parsed.artifact_id}.${first}`;
  } catch {
    return result.startsWith("Error:") ? result : `Diagnostics completed:\n${result.slice(0, 1000)}`;
  }
}

export function clearAutomationState(): void {
  automations.clear();
  if (existsSync(ATTEMPT_DIR)) rmSync(ATTEMPT_DIR, { recursive: true, force: true });
}

export function registerDiagnosticsTools(): void {
  const registry = getRegistry();
  const add = (
    name: string,
    description: string,
    execute: (args: Record<string, unknown>) => Promise<string>,
    permission = PermissionLevel.ALWAYS_ALLOW,
    deferLoading = true,
  ) => registry.register({
    name,
    description,
    parameters: { type: "object", properties: {} },
    execute,
    permission,
    category: name.startsWith("github") ? "github" : name.startsWith("automation") ? "automation" : "diagnostics",
    parallelOk: true,
    deferLoading,
  });

  registry.register({
    name: "diagnostics",
    description: "Collect workspace, git, runtime, and tool diagnostics.",
    parameters: { type: "object", properties: { workdir: { type: "string", default: "." } } },
    execute: diagnostics,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "diagnostics",
    parallelOk: true,
  });
  add("github_issue_context", "Read GitHub issue context via gh.", githubIssueContext);
  add("github_pr_context", "Read GitHub PR context via gh.", githubPrContext);
  add("github_comment", "Comment on a GitHub issue or PR via gh.", githubComment, PermissionLevel.ASK);
  add("github_close_issue", "Close a GitHub issue via gh with a required reason.", githubCloseIssue, PermissionLevel.ASK);
  add("pr_attempt_record", "Record current git diff as a PR attempt patch.", prAttemptRecord);
  add("pr_attempt_list", "List recorded PR attempt patches.", prAttemptList);
  add("pr_attempt_read", "Read a PR attempt patch.", prAttemptRead);
  add("pr_attempt_preflight", "Run git apply --check for a PR attempt patch.", prAttemptPreflight);
  add("pr_attempt_branch", "Create a branch for a PR attempt.", prAttemptBranch, PermissionLevel.ASK);
  add("pr_attempt_gate", "Run a PR attempt verification gate and archive evidence.", prAttemptGate, PermissionLevel.ASK);
  add("pr_attempt_push_draft", "Push current branch and create a draft GitHub PR.", prAttemptPushDraft, PermissionLevel.ASK);
  add("pr_attempt_review_sync", "Sync GitHub PR review comments into an artifact.", prAttemptReviewSync);
  add("pr_attempt_rollback", "Rollback a PR attempt branch or current branch to a target revision.", prAttemptRollback, PermissionLevel.ASK);
  add("automation_create", "Create an automation record.", automationCreate, PermissionLevel.ASK);
  add("automation_list", "List automation records.", automationList);
  add("automation_read", "Read an automation record.", automationRead);
  add("automation_update", "Update an automation record.", automationUpdate, PermissionLevel.ASK);
  add("automation_pause", "Pause an automation.", args => automationStatus(args, true), PermissionLevel.ASK);
  add("automation_resume", "Resume an automation.", args => automationStatus(args, false), PermissionLevel.ASK);
  add("automation_delete", "Delete an automation.", automationDelete, PermissionLevel.ASK);
  add("automation_run", "Run an automation by creating a durable task.", automationRun, PermissionLevel.ASK);
  registry.register({
    name: "mcp_manager",
    description: "Manage MCP servers: list, add, enable, disable, remove, reload. Writes user config for persistent changes.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "enable", "disable", "remove", "reload", "health", "reconnect"], default: "list" },
        name: { type: "string" },
        transport: { type: "string", enum: ["stdio", "sse"], default: "stdio" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        url: { type: "string" },
        env: { type: "object" },
        enabled: { type: "boolean", default: true },
      },
    },
    execute: mcpManager,
    permission: PermissionLevel.ASK,
    category: "mcp",
    parallelOk: false,
  });
  registry.register({
    name: "lsp_diagnostics",
    description: "Run language diagnostics using available project tools or language servers for TypeScript, Python, Go, or Rust.",
    parameters: {
      type: "object",
      properties: {
        workdir: { type: "string", default: "." },
        language: { type: "string", enum: ["typescript", "python", "go", "rust"] },
        files: { type: "array", items: { type: "string" }, description: "Optional file paths to keep in the returned diagnostics." },
        min_severity: { type: "string", enum: ["error", "warning", "information", "hint", "all"], default: "all" },
      },
    },
    execute: lspDiagnostics,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "diagnostics",
    parallelOk: true,
  });
}

function githubMutationGuard(args: Record<string, unknown>, options: { requireClean: boolean }): string | null {
  const workdir = String(args.workdir || ".");
  const status = runRaw("git status --porcelain=v1 2>&1", workdir);
  if (/fatal: not a git repository/i.test(status)) return "Error: GitHub mutations require a git repository workdir.";
  if (options.requireClean && status.trim()) {
    const artifact = createArtifact({ kind: "github_guard", name: "dirty-worktree.txt", content: status, metadata: { workdir: resolve(workdir) } });
    return `Error: dirty worktree guard blocked GitHub mutation. Commit/stash changes or pass allow_dirty=true. Evidence artifact: ${artifact.id}`;
  }
  if (!commandExists("gh")) return "Error: GitHub CLI 'gh' is required.";
  return null;
}

function ensureGitRepo(workdir: string): string | null {
  const status = run("git rev-parse --is-inside-work-tree 2>&1", workdir);
  return status.trim() === "true" ? null : "Error: operation requires a git repository workdir.";
}

function verifyGithubTarget(target: string, workdir: string): string {
  const result = runWithStatus(`gh issue view ${JSON.stringify(target)} --json number,title,state,url 2>&1`, workdir);
  if (result.status !== 0) return `Error: GitHub target verification failed: ${result.output}`;
  try {
    const evidence = JSON.parse(result.output) as { number?: unknown; url?: unknown };
    if (!evidence || evidence.number === undefined || !evidence.url) {
      return `Error: GitHub target verification returned incomplete evidence: ${result.output}`;
    }
  } catch {
    return `Error: GitHub target verification returned invalid JSON: ${result.output}`;
  }
  return result.output;
}

function parseMCPServer(args: Record<string, unknown>): MCPConfig {
  const name = String(args.name || "").trim();
  if (!name) throw new Error("name is required.");
  const transport = String(args.transport || (args.url ? "sse" : "stdio")) as MCPConfig["transport"];
  const server: MCPConfig = {
    name,
    transport,
    command: args.command ? String(args.command) : undefined,
    args: Array.isArray(args.args) ? args.args.map(String) : args.args ? String(args.args).split(/\s+/).filter(Boolean) : [],
    url: args.url ? String(args.url) : undefined,
    env: typeof args.env === "object" && args.env !== null ? args.env as Record<string, string> : {},
    enabled: args.enabled !== false,
  };
  if (server.transport === "stdio" && !server.command) throw new Error("command is required for stdio MCP servers.");
  if (server.transport === "sse" && !server.url) throw new Error("url is required for SSE MCP servers.");
  return server;
}

function diagnosticCommand(language: string, workdir: string): string | null {
  if (language === "typescript") {
    if (existsSync(join(workdir, "package.json"))) {
      const localTsc = join(workdir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
      if (existsSync(localTsc)) return `${JSON.stringify(localTsc)} --noEmit --pretty false 2>&1`;
      if (commandExists("tsc")) return "tsc --noEmit --pretty false 2>&1";
      const bundledTsc = resolve("node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
      if (existsSync(bundledTsc)) return `${JSON.stringify(bundledTsc)} --noEmit --pretty false 2>&1`;
      return "npx --no-install tsc --noEmit --pretty false 2>&1";
    }
    return "tsserver --help >/dev/null 2>&1 && echo 'tsserver available; project has no package.json for batch diagnostics' || echo 'tsserver not found'";
  }
  if (language === "python") {
    if (commandExists("pyright")) return "pyright --outputjson 2>&1";
    return "python -m py_compile $(find . -name '*.py' -not -path './.venv/*' -not -path './venv/*') 2>&1";
  }
  if (language === "go") return "gopls check ./... 2>&1 || go test ./... 2>&1";
  if (language === "rust") return "cargo check --message-format short 2>&1 || rust-analyzer diagnostics . 2>&1";
  return null;
}

function detectLanguage(workdir: string): string {
  if (existsSync(join(workdir, "package.json")) || existsSync(join(workdir, "tsconfig.json"))) return "typescript";
  if (existsSync(join(workdir, "pyproject.toml")) || existsSync(join(workdir, "requirements.txt"))) return "python";
  if (existsSync(join(workdir, "go.mod"))) return "go";
  if (existsSync(join(workdir, "Cargo.toml"))) return "rust";
  return "typescript";
}

interface ParsedDiagnostic {
  file: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "information" | "hint";
  code?: string;
  message: string;
}

function normalizeFiles(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function parseDiagnostics(output: string, language: string): ParsedDiagnostic[] {
  if (language === "python") {
    try {
      const parsed = JSON.parse(output) as { generalDiagnostics?: Array<any> };
      return (parsed.generalDiagnostics || []).map(item => ({
        file: String(item.file || ""),
        line: typeof item.range?.start?.line === "number" ? item.range.start.line + 1 : undefined,
        column: typeof item.range?.start?.character === "number" ? item.range.start.character + 1 : undefined,
        severity: normalizeSeverity(item.severity),
        message: String(item.message || ""),
        code: item.rule ? String(item.rule) : undefined,
      }));
    } catch {
      // fall through to regex parser
    }
  }

  const diagnostics: ParsedDiagnostic[] = [];
  const tsPattern = /(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s+(.+)/i;
  const colonPattern = /(.+?):(\d+):(\d+):\s+(error|warning|info|information|hint)(?:\[[^\]]+\])?:\s+(.+)/i;
  for (const line of output.split("\n")) {
    const ts = line.match(tsPattern);
    if (ts) {
      diagnostics.push({
        file: ts[1],
        line: Number(ts[2]),
        column: Number(ts[3]),
        severity: normalizeSeverity(ts[4]),
        code: ts[5],
        message: ts[6],
      });
      continue;
    }
    const colon = line.match(colonPattern);
    if (colon) {
      diagnostics.push({
        file: colon[1],
        line: Number(colon[2]),
        column: Number(colon[3]),
        severity: normalizeSeverity(colon[4]),
        message: colon[5],
      });
    }
  }
  return diagnostics;
}

function filterDiagnostics(
  diagnostics: ParsedDiagnostic[],
  options: { files: string[]; minSeverity: string; workdir: string },
): ParsedDiagnostic[] {
  const minRank = options.minSeverity === "all" ? Infinity : severityRank(normalizeSeverity(options.minSeverity));
  const root = resolve(options.workdir);
  const filters = options.files.map(file => resolve(root, file));
  return diagnostics.filter(diagnostic => {
    if (severityRank(diagnostic.severity) > minRank) return false;
    if (!filters.length) return true;
    const diagPath = resolve(root, diagnostic.file);
    return filters.some(file => diagPath === file || diagnostic.file.endsWith(file) || diagPath.endsWith(file));
  });
}

function summarizeDiagnostics(diagnostics: ParsedDiagnostic[]): { total: number; by_severity: Record<string, number> } {
  const bySeverity: Record<string, number> = {};
  for (const diagnostic of diagnostics) bySeverity[diagnostic.severity] = (bySeverity[diagnostic.severity] || 0) + 1;
  return { total: diagnostics.length, by_severity: bySeverity };
}

function normalizeSeverity(value: unknown): ParsedDiagnostic["severity"] {
  const text = String(value || "").toLowerCase();
  if (text === "error") return "error";
  if (text === "warning" || text === "warn") return "warning";
  if (text === "hint") return "hint";
  return "information";
}

function severityRank(severity: ParsedDiagnostic["severity"]): number {
  switch (severity) {
    case "error": return 0;
    case "warning": return 1;
    case "information": return 2;
    case "hint": return 3;
  }
}

function formatDiagnostic(diagnostic: ParsedDiagnostic): string {
  const location = [diagnostic.file, diagnostic.line, diagnostic.column].filter(Boolean).join(":");
  return `${location} ${diagnostic.severity}${diagnostic.code ? ` ${diagnostic.code}` : ""}: ${diagnostic.message}`;
}

function commandExists(command: string): boolean {
  return spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)}`], { encoding: "utf-8" }).status === 0;
}

function withArtifact(output: string, artifactId: string): string {
  return `${output}\n\n[artifact] ${artifactId}`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "target";
}
