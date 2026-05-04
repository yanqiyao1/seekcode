/** Approval policy, sandbox mode, trust boundary, and workspace boundary checks. */

import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import type { ApprovalContext } from "./base.js";
import { checkCommand } from "./exec-policy.js";

export type SandboxDecision = "allow" | "ask" | "deny";

export interface SandboxCheckResult {
  decision: SandboxDecision;
  reason: string;
}

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "github_comment", "github_close_issue", "mcp_manager"]);
const FILE_PATH_ARGS = ["path", "target_file", "workdir", "root", "cwd", "workspace"];
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
  if (config.sandbox_mode === "read-only" && isMutationTool(ctx.tool_name)) {
    return { decision: "deny", reason: "read-only sandbox blocks mutating tools" };
  }

  if (ctx.tool_name === "bash") {
    const command = String(ctx.tool_args.command || "");
    if (config.sandbox_mode === "read-only" && !isReadOnlyShell(command)) {
      return { decision: "deny", reason: "read-only sandbox blocks shell mutations" };
    }
    if (config.workspace_boundary && shellCommandEscapesWorkspace(command, workspace)) {
      return { decision: "deny", reason: `shell command escapes workspace boundary: ${workspace}` };
    }
    const commandPolicy = checkCommand(command);
    if (commandPolicy.decision === "deny") {
      return { decision: "deny", reason: `shell command blocked by policy: ${commandPolicy.justification}` };
    }
    if (!trusted && DANGEROUS_SHELL_PATTERNS.some(pattern => pattern.test(command))) {
      return { decision: "deny", reason: "untrusted workspace blocks dangerous shell command" };
    }
  }

  if (config.approval_policy === "untrusted" && !trusted && isMutationTool(ctx.tool_name)) {
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

function isMutationTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
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

function isReadOnlyShell(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] || "";
  if (!["cat", "grep", "rg", "find", "ls", "pwd", "head", "tail", "wc", "git"].includes(first)) return false;
  if (/[;&|`$()<>]/.test(command)) return false;
  if (/\b(?:rm|mv|cp|touch|mkdir|rmdir|chmod|chown|dd|mkfs|tee|sed\s+-i)\b/.test(command)) return false;
  return true;
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
