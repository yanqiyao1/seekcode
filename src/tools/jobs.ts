/** Background shell job manager used by shell tools and /jobs. */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkCommand } from "./exec-policy.js";
import { createArtifact, linkArtifact } from "../artifacts/store.js";

export type JobStatus = "running" | "completed" | "failed" | "killed" | "stale";

export interface ShellJob {
  id: string;
  command: string;
  workdir: string;
  status: JobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  output: string;
  pid?: number;
  logFile?: string;
  inputFile?: string;
  statusFile?: string;
  commandFile?: string;
  supervisorFile?: string;
  artifactIds?: string[];
  pty?: boolean;
  reattachable?: boolean;
  lastInputAt?: number;
}

interface InternalJob extends ShellJob {
  proc?: ChildProcess;
}

const MAX_OUTPUT_CHARS = 200_000;

interface StartOptions {
  pty?: boolean;
  timeoutMs?: number;
}

class JobManager {
  private jobs = new Map<string, InternalJob>();
  private dataDir: string;

  constructor(dataDir = defaultJobsDir()) {
    this.dataDir = dataDir;
    this.loadPersistedJobs();
  }

  start(command: string, workdir = ".", options: StartOptions = {}): ShellJob {
    const policy = checkCommand(command);
    if (policy.decision === "deny") {
      throw new Error(`Command blocked by policy: ${policy.justification}`);
    }

    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(this.dataDir, { recursive: true });
    const logFile = join(this.dataDir, `${id}.log`);
    const inputFile = join(this.dataDir, `${id}.in`);
    const statusFile = join(this.dataDir, `${id}.status.json`);
    const commandFile = join(this.dataDir, `${id}.cmd`);
    const supervisorFile = join(this.dataDir, `${id}.supervisor.sh`);
    const readyFile = join(this.dataDir, `${id}.ready.json`);
    const usePty = options.pty !== false;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? Math.floor(options.timeoutMs!) : 0;
    writeFileSync(logFile, "", { encoding: "utf-8", flag: "a" });
    writeFileSync(commandFile, command, "utf-8");
    writeFileSync(supervisorFile, supervisorScript(), { encoding: "utf-8", mode: 0o700 });
    try { rmSync(inputFile, { force: true }); } catch { /* ignore stale fifo */ }
    execFileSync("mkfifo", [inputFile]);

    const proc = spawn("bash", [supervisorFile, inputFile, logFile, commandFile, statusFile, readyFile, usePty ? "pty" : "pipe", String(timeoutMs)], {
      cwd: workdir,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
    const job: InternalJob = {
      id,
      command,
      workdir,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      output: "",
      pid: proc.pid,
      logFile,
      inputFile,
      statusFile,
      commandFile,
      supervisorFile,
      pty: usePty,
      reattachable: true,
      proc,
    };
    this.jobs.set(id, job);
    this.persistJob(job);
    proc.on("error", error => {
      job.status = "failed";
      job.endedAt = Date.now();
      job.output = appendOutput(job.output, `\nError: ${error.message}`);
      job.proc = undefined;
      this.persistJob(job);
    });
    proc.on("exit", () => {
      job.proc = undefined;
      this.refreshJob(job);
    });
    return this.snapshot(job);
  }

  get(id: string): ShellJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(this.refreshJob(job)) : undefined;
  }

  list(): ShellJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(job => this.snapshot(this.refreshJob(job)));
  }

  write(id: string, input: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.refreshJob(job);
    if (job.status !== "running" || !job.inputFile || !existsSync(job.inputFile)) return false;
    try {
      writeFileSync(job.inputFile, input, { encoding: "utf-8", flag: "a" });
      job.lastInputAt = Date.now();
      this.persistJob(job);
      return true;
    } catch {
      this.refreshJob(job);
      return false;
    }
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.refreshJob(job);
    if (job.status !== "running") return false;
    job.status = "killed";
    job.endedAt = Date.now();
    if (job.pid) killProcessGroup(job.pid);
    job.proc = undefined;
    this.persistJob(job);
    return true;
  }

  prune(maxAgeMs = 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, job] of this.jobs) {
      this.refreshJob(job);
      if (job.status === "running") continue;
      if ((job.endedAt ?? job.startedAt) > now - maxAgeMs) continue;
      this.jobs.delete(id);
      this.removePersistedJob(id, job);
      removed++;
    }
    return removed;
  }

  clear(): void {
    for (const job of this.jobs.values()) {
      this.refreshJob(job);
      if (job.status === "running" && job.pid) killProcessGroup(job.pid);
    }
    this.jobs.clear();
    try { rmSync(this.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  private snapshot(job: InternalJob): ShellJob {
    const { proc: _proc, ...snapshot } = job;
    return { ...snapshot };
  }

  private loadPersistedJobs(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      for (const file of readdirSync(this.dataDir).filter(name => /^job_[a-z0-9_]+\.json$/.test(name))) {
        try {
          const job = JSON.parse(readFileSync(join(this.dataDir, file), "utf-8")) as InternalJob;
          job.proc = undefined;
          this.jobs.set(job.id, job);
          this.refreshJob(job);
        } catch {
          // skip corrupt job metadata
        }
      }
    } catch {
      // use memory-only jobs if persistence fails
    }
  }

  private persistJob(job: InternalJob): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const { proc: _proc, ...snapshot } = job;
      writeFileSync(join(this.dataDir, `${job.id}.json`), JSON.stringify(snapshot, null, 2), "utf-8");
    } catch {
      // keep in-memory job state
    }
  }

  private removePersistedJob(id: string, job: InternalJob): void {
    try { rmSync(join(this.dataDir, `${id}.json`), { force: true }); } catch { /* ignore */ }
    for (const path of [
      job.logFile,
      job.inputFile,
      job.statusFile,
      job.statusFile ? `${job.statusFile}.pid` : undefined,
      job.commandFile,
      job.supervisorFile,
      join(this.dataDir, `${id}.ready.json`),
    ]) {
      if (!path) continue;
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }

  private refreshJob(job: InternalJob): InternalJob {
    let changed = false;
    if (job.logFile && existsSync(job.logFile)) {
      try {
        const output = readFileSync(job.logFile, "utf-8").slice(-MAX_OUTPUT_CHARS);
        if (output !== job.output) {
          job.output = output;
          changed = true;
        }
      } catch {
        // keep persisted output
      }
    }

    const status = readStatusFile(job.statusFile);
    if (status && job.status !== "killed") {
      const exitCode = status.exitCode;
      const endedAt = status.endedAt || statusFileMtime(job.statusFile) || Date.now();
      if (job.status !== (exitCode === 0 ? "completed" : "failed")) changed = true;
      job.status = exitCode === 0 ? "completed" : "failed";
      job.exitCode = exitCode;
      job.signal = null;
      job.endedAt = endedAt;
      job.proc = undefined;
      this.archiveCompletedOutput(job);
    } else if (job.status === "running") {
      if (job.pid && isProcessAlive(job.pid)) {
        job.reattachable = Boolean(job.inputFile && existsSync(job.inputFile));
      } else {
        job.status = "stale";
        job.endedAt = Date.now();
        job.proc = undefined;
        job.output = appendOutput(job.output, "\n[stale] Supervisor is no longer running and no exit status was recorded.\n");
        changed = true;
      }
    }

    if (changed) this.persistJob(job);
    return job;
  }

  private archiveCompletedOutput(job: InternalJob): void {
    if (job.artifactIds?.length || !job.output) return;
    const artifact = createArtifact({
      kind: "job_log",
      name: `${job.id}.log`,
      content: job.output,
      extension: ".log",
      metadata: { job_id: job.id, command: job.command, workdir: job.workdir, status: job.status },
    });
    job.artifactIds = [artifact.id];
    linkArtifact(artifact.id, "job", job.id, { status: job.status });
  }
}

let manager: JobManager | null = null;

export function getJobManager(): JobManager {
  if (!manager) manager = new JobManager();
  return manager;
}

export function clearJobManagerForTests(): void {
  manager?.clear();
  manager = null;
}

export function reloadJobManagerForTests(): void {
  manager = null;
}

export function formatJob(job: ShellJob, tailChars = 4000): string {
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const lines = [
    `id: ${job.id}`,
    `status: ${job.status}`,
    `command: ${job.command}`,
    `cwd: ${job.workdir}`,
    `elapsed: ${elapsed.toFixed(1)}s`,
  ];
  if (job.exitCode !== null) lines.push(`exit_code: ${job.exitCode}`);
  if (job.signal) lines.push(`signal: ${job.signal}`);
  if (job.pid) lines.push(`pid: ${job.pid}`);
  if (job.logFile) lines.push(`log: ${job.logFile}`);
  if (job.inputFile) lines.push(`input: ${job.inputFile}`);
  lines.push(`pty: ${job.pty ? "yes" : "no"}`);
  lines.push(`reattachable: ${job.reattachable ? "yes" : "no"}`);
  if (job.output) lines.push("", job.output.slice(-tailChars).trimEnd());
  return lines.join("\n");
}

export function defaultJobsDir(): string {
  if (process.env.DEEPCODE_JOBS_DIR) return resolve(process.env.DEEPCODE_JOBS_DIR);
  if (process.env.DEEPSEEK_JOBS_DIR) return resolve(process.env.DEEPSEEK_JOBS_DIR);
  const xdg = process.env.XDG_DATA_HOME || resolve(process.env.HOME || "~", ".local", "share");
  return join(xdg, "deepseek", "jobs");
}

function appendOutput(existing: string | undefined, next: string): string {
  const combined = `${existing || ""}${next}`;
  return combined.length > MAX_OUTPUT_CHARS ? combined.slice(combined.length - MAX_OUTPUT_CHARS) : combined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function killProcessGroup(pid: number): void {
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

function readStatusFile(path?: string): { exitCode: number; endedAt?: number } | null {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { exitCode?: unknown; endedAt?: unknown };
    const exitCode = Number(parsed.exitCode);
    if (!Number.isFinite(exitCode)) return null;
    const endedAt = Number(parsed.endedAt);
    return { exitCode, endedAt: Number.isFinite(endedAt) ? endedAt : undefined };
  } catch {
    return null;
  }
}

function statusFileMtime(path?: string): number | undefined {
  if (!path) return undefined;
  try { return statSync(path).mtimeMs; } catch { return undefined; }
}

function supervisorScript(): string {
  return `#!/usr/bin/env bash
set +e
fifo="$1"
log="$2"
command_file="$3"
status="$4"
ready="$5"
mode="$6"
timeout_ms="\${7:-0}"
echo "$$" > "$status.pid"
touch "$log"
exec 3<>"$fifo"
now="$(date +%s%3N 2>/dev/null)"
case "$now" in ""|*[!0-9]*) now="$(($(date +%s) * 1000))" ;; esac
printf '{"readyAt":%s}\\n' "$now" > "$ready"
cmd="$(cat "$command_file")"
run_with_timeout() {
  if [[ "$timeout_ms" =~ ^[0-9]+$ ]] && [[ "$timeout_ms" -gt 0 ]] && command -v timeout >/dev/null 2>&1; then
    seconds="$(( (timeout_ms + 999) / 1000 ))"
    timeout --kill-after=1s "$seconds"s "$@"
  else
    "$@"
  fi
}
if [[ "$mode" == "pty" ]] && command -v script >/dev/null 2>&1; then
  run_with_timeout script -q -f -e -c "$cmd" "$log" <&3
  code=$?
else
  run_with_timeout bash -lc "$cmd" <&3 >>"$log" 2>&1
  code=$?
fi
if [[ "$code" == "124" || "$code" == "137" ]]; then
  printf '\\n[timeout after %sms]\\n' "$timeout_ms" >> "$log"
fi
ended="$(date +%s%3N 2>/dev/null)"
case "$ended" in ""|*[!0-9]*) ended="$(($(date +%s) * 1000))" ;; esac
printf '{"exitCode":%s,"endedAt":%s}\\n' "$code" "$ended" > "$status"
exit "$code"
`;
}
