/** Approval policy, sandbox mode, trust boundary, and workspace boundary checks. */

import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import type { ApprovalContext } from "./base.js";
import { isToolDestructive, isToolReadOnly } from "./base.js";
import { checkCommand, isCommandReadOnly } from "./exec-policy.js";

export type SandboxDecision = "allow" | "ask" | "deny";

export interface SandboxCheckResult {
  decision: SandboxDecision;
  reason: string;
}

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "github_comment", "github_close_issue", "mcp_manager"]);
const FILE_PATH_ARGS = ["path", "target_file", "workdir", "root", "cwd", "workspace"];
const SHELL_COMMAND_TOOLS = new Set(["bash", "task_shell_start", "task_gate_run", "task_create"]);
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bchmod\s+(?:-R\s+)?777\b/,
  /\bdd\s+if=/,
  /\bmkfs\./,
  />\s*\/dev\/sd[a-z]/,
  /:\{\s*:\|:&\s*\};:/,
];

export function checkSandboxPolicy(config: Config, ctx: ApprovalContext): SandboxCheckResult {
  if (config.sandbox_mode === "danger-full-access" && config.approval_policy === "never") {
    return { decision: "allow", reason: "danger-full-access with never approval policy" };
  }

  const workspace = resolve(ctx.workspace_path || ".");
  if (config.workspace_boundary && escapesWorkspace(ctx, workspace)) {
    return { decision: "deny", reason: `tool arguments escape workspace boundary: ${workspace}` };
  }

  const trusted = isTrustedWorkspace(config, workspace);
  if (config.sandbox_mode === "read-only" && isMutationTool(ctx)) {
    return { decision: "deny", reason: "read-only sandbox blocks mutating tools" };
  }

  const shellCommand = getShellCommand(ctx);
  if (shellCommand !== null) {
    if (config.sandbox_mode === "read-only" && !isCommandReadOnly(shellCommand)) {
      return { decision: "deny", reason: "read-only sandbox blocks shell mutations" };
    }
    if (config.workspace_boundary && shellCommandEscapesWorkspace(shellCommand, workspace)) {
      return { decision: "deny", reason: `shell command escapes workspace boundary: ${workspace}` };
    }
    const commandPolicy = checkCommand(shellCommand);
    if (commandPolicy.decision === "deny") {
      return { decision: "deny", reason: `shell command blocked by policy: ${commandPolicy.justification}` };
    }
    if (commandPolicy.decision === "ask") {
      return { decision: "ask", reason: `shell command requires approval: ${commandPolicy.justification}` };
    }
    if (!trusted && DANGEROUS_SHELL_PATTERNS.some(pattern => pattern.test(shellCommand))) {
      return { decision: "deny", reason: "untrusted workspace blocks dangerous shell command" };
    }
  }

  if (config.approval_policy === "untrusted" && !trusted && isMutationTool(ctx)) {
    return { decision: "ask", reason: "mutation in untrusted workspace requires approval" };
  }
  if (config.approval_policy === "never") return { decision: "allow", reason: "approval policy never" };
  return { decision: "allow", reason: "sandbox policy passed" };
}

export function isTrustedWorkspace(config: Config, workspacePath: string): boolean {
  const workspace = resolve(workspacePath || ".");
  return (config.trusted_workspaces || []).some(item => {
    const trusted = resolve(expandHome(item));
    return workspace === trusted || workspace.startsWith(`${trusted}/`);
  });
}

function isMutationTool(ctx: ApprovalContext): boolean {
  if (isToolDestructive(ctx.tool_def, ctx.tool_args)) return true;
  if (isToolReadOnly(ctx.tool_def, ctx.tool_args)) return false;
  return WRITE_TOOLS.has(ctx.tool_name);
}

function getShellCommand(ctx: ApprovalContext): string | null {
  if (!SHELL_COMMAND_TOOLS.has(ctx.tool_name)) return null;
  const raw = ctx.tool_args.command;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function escapesWorkspace(ctx: ApprovalContext, workspace: string): boolean {
  for (const key of FILE_PATH_ARGS) {
    const raw = ctx.tool_args[key];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    if (!isInsideWorkspace(resolve(workspace, raw), workspace)) return true;
  }
  if (Array.isArray(ctx.tool_args.files)) {
    for (const raw of ctx.tool_args.files) {
      if (typeof raw !== "string" || raw.trim() === "") continue;
      if (!isInsideWorkspace(resolve(workspace, raw), workspace)) return true;
    }
  }
  return false;
}

function isInsideWorkspace(path: string, workspace: string): boolean {
  const rel = relative(workspace, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}

function shellCommandEscapesWorkspace(command: string, workspace: string): boolean {
  for (const token of tokenizeShell(command)) {
    if (!token || !looksLikePath(token)) continue;
    const path = token.replace(/^file:\/\//, "");
    if (isAbsolute(path) && !isInsideWorkspace(resolve(path), workspace)) return true;
  }
  return false;
}

function tokenizeShell(command: string): string[] {
  return command
    .split(/[\s"'`]+/)
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => token.replace(/[),;|&]+$/g, "").replace(/^[({]+/g, ""));
}

function looksLikePath(token: string): boolean {
  return token.startsWith("/") || token.startsWith("file:///");
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME || path;
  if (path.startsWith("~/")) return `${process.env.HOME || "~"}${path.slice(1)}`;
  return path;
}
