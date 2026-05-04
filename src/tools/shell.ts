/** Shell execution tool with exec policy integration. */

import { spawn } from "node:child_process";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { checkCommand } from "./exec-policy.js";
import { formatJob, getJobManager } from "./jobs.js";

async function bash(args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  const timeout = (args.timeout as number) || 120000;
  const workdir = (args.workdir as string) || ".";
  if (args.background === true) {
    try {
      const job = getJobManager().start(command, workdir, {
        pty: args.pty !== false,
        timeoutMs: normalizeTimeout(args.timeout),
      });
      return `Started background job ${job.id} (pid ${job.pid ?? "unknown"}). Poll with exec_shell_wait or task_shell_wait.`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  // Check against exec policy
  const policy = checkCommand(command);
  if (policy.decision === "deny") {
    return `Error: Command blocked by policy: ${policy.justification}`;
  }
  // If policy says "ask", the mode's approval mechanism handles it
  return new Promise((resolve) => {
    try {
      const proc = spawn("bash", ["-c", command], {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      });
      let stdout = "", stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc.pid);
      }, timeout);
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        const parts: string[] = [];
        if (stdout) parts.push(stdout.trimEnd());
        if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        if (timedOut) parts.push(`[timed out after ${timeout}ms]`);
        if (signal) parts.push(`[signal: ${signal}]`);
        parts.push(`[exit code: ${code}]`);
        resolve(parts.join("\n"));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve(`Error executing command: ${err.message}`);
      });
    } catch (e: any) { resolve(`Error: ${e.message}`); }
  });
}

async function execShellWait(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.job_id || "");
  if (!id) return "Error: id is required.";
  const job = getJobManager().get(id);
  if (!job) return `Error: job not found: ${id}`;
  return formatJob(job, (args.tail_chars as number) || 4000);
}

async function execShellInteract(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.job_id || "");
  const input = String(args.input ?? "");
  if (!id) return "Error: id is required.";
  const ok = getJobManager().write(id, input);
  return ok ? `Sent ${input.length} byte(s) to ${id}.` : `Error: job is not running or not found: ${id}`;
}

async function execShellCancel(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.job_id || "");
  if (!id) return "Error: id is required.";
  return getJobManager().cancel(id) ? `Cancelled job ${id}.` : `Error: job is not running or not found: ${id}`;
}

async function taskShellStart(args: Record<string, unknown>): Promise<string> {
  return bash({ ...args, background: true });
}

function normalizeTimeout(value: unknown): number | undefined {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

function killProcessGroup(pid?: number): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }, 250).unref?.();
}

export function registerShellTool(): void {
  const r = getRegistry();
  r.register({
    name: "bash", description: "Execute a shell command. Returns stdout, stderr, exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer", default: 120000 },
        workdir: { type: "string", default: "." },
        background: { type: "boolean", default: false },
        pty: { type: "boolean", default: true, description: "Run background command under a PTY-compatible script wrapper." },
      },
      required: ["command"],
    },
    execute: bash, permission: PermissionLevel.ASK, category: "shell", parallelOk: false,
  });
  r.register({
    name: "exec_shell_wait",
    description: "Poll a background shell job by id and return status plus output tail.",
    parameters: { type: "object", properties: { id: { type: "string" }, tail_chars: { type: "integer", default: 4000 } }, required: ["id"] },
    execute: execShellWait,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "shell",
    parallelOk: true,
  });
  r.register({
    name: "exec_shell_interact",
    description: "Send stdin to a running background shell job.",
    parameters: { type: "object", properties: { id: { type: "string" }, input: { type: "string" } }, required: ["id", "input"] },
    execute: execShellInteract,
    permission: PermissionLevel.ASK,
    category: "shell",
    parallelOk: false,
    deferLoading: true,
  });
  r.register({
    name: "exec_shell_cancel",
    description: "Cancel a running background shell job by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: execShellCancel,
    permission: PermissionLevel.ASK,
    category: "shell",
    parallelOk: true,
  });
  r.register({
    name: "task_shell_start",
    description: "Start a long-running shell command in the background and return immediately.",
    parameters: { type: "object", properties: { command: { type: "string" }, workdir: { type: "string", default: "." }, timeout: { type: "integer", default: 120000 }, pty: { type: "boolean", default: true } }, required: ["command"] },
    execute: taskShellStart,
    permission: PermissionLevel.ASK,
    category: "shell",
    parallelOk: true,
  });
  r.register({
    name: "task_shell_wait",
    description: "Poll a long-running task shell job by id.",
    parameters: { type: "object", properties: { id: { type: "string" }, tail_chars: { type: "integer", default: 4000 } }, required: ["id"] },
    execute: execShellWait,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "shell",
    parallelOk: true,
  });
}
