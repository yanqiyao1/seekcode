/** Git operation tools. */

import { spawnSync } from "node:child_process";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

function runGit(args: string[], workdir = "."): string {
  try {
    const result = spawnSync("git", args, { cwd: workdir, encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    if (result.error) return result.error.message;
    const output = result.status === 0 ? result.stdout : (result.stderr || result.stdout);
    return output.trim() || "(no output)";
  } catch (e: any) { return e.stderr?.trim() || e.message || "Error running git"; }
}

function splitFiles(files: unknown): string[] {
  if (!files) return [];
  if (Array.isArray(files)) return files.map(String).filter(Boolean);
  const value = String(files).trim();
  return value ? [value] : [];
}

async function gitStatus(a: Record<string, unknown>): Promise<string> { return runGit(["status", "--short"], (a.workdir as string) || "."); }
async function gitDiff(a: Record<string, unknown>): Promise<string> {
  const args = ["diff"]; if (a.staged) args.push("--staged"); args.push("--", ...splitFiles(a.files));
  return runGit(args, (a.workdir as string) || ".");
}
async function gitLog(a: Record<string, unknown>): Promise<string> { return runGit(["log", `-${a.n || 10}`, "--oneline", "--decorate"], (a.workdir as string) || "."); }
async function gitBranch(a: Record<string, unknown>): Promise<string> { return runGit(["branch", "--list"], (a.workdir as string) || "."); }

export function registerGitTools(): void {
  const r = getRegistry();
  r.register({ name: "git_status", description: "Show git working tree status.", parameters: { type: "object", properties: { workdir: { type: "string", default: "." } } }, execute: gitStatus, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true });
  r.register({ name: "git_diff", description: "Show git diff.", parameters: { type: "object", properties: { staged: { type: "boolean", default: false }, files: { type: "string", default: "" }, workdir: { type: "string", default: "." } } }, execute: gitDiff, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true });
  r.register({ name: "git_log", description: "Show recent commit history.", parameters: { type: "object", properties: { n: { type: "integer", default: 10 }, workdir: { type: "string", default: "." } } }, execute: gitLog, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true });
  r.register({ name: "git_branch", description: "List local branches.", parameters: { type: "object", properties: { workdir: { type: "string", default: "." } } }, execute: gitBranch, permission: PermissionLevel.ALWAYS_ALLOW, category: "git", parallelOk: true });
}
