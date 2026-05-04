/** Task lifecycle system with typed tasks, smart IDs, and terminal state tracking.
 *
 * Adopted from claude-code-rev: supports 7 task types with proper lifecycle
 * management, cryptographically random IDs, duration tracking, and
 * terminal-status detection for cleanup/dispatch.
 */

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkCommand } from "../tools/exec-policy.js";
import { createArtifact, linkArtifact } from "../artifacts/store.js";

// ── Types ────────────────────────────────────────────────────

export type TaskType =
  | "bash"
  | "agent"
  | "remote_agent"
  | "workflow"
  | "monitor"
  | "sub_task"
  | "background";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

export function isActiveStatus(status: TaskStatus): boolean {
  return status === "pending" || status === "running";
}

// ── Task ID ──────────────────────────────────────────────────

const TASK_ID_PREFIXES: Record<TaskType, string> = {
  bash: "b",
  agent: "a",
  remote_agent: "r",
  workflow: "w",
  monitor: "m",
  sub_task: "s",
  background: "bg",
};

// Case-insensitive-safe alphabet: digits + lowercase = 36 chars.
// 36^8 ≈ 2.8 trillion combinations.
const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type] || "x";
  const bytes = randomBytes(8);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length];
  }
  return id;
}

// ── Task Record ──────────────────────────────────────────────

export interface TaskRecord {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  agentId?: string;
  startTime: number;
  endTime?: number;
  totalPausedMs?: number;
  /** The output accumulated so far */
  output?: string;
  outputFile?: string;
  artifactIds?: string[];
  /** Whether the user has been notified of completion */
  notified: boolean;
  /** Progress events for this task */
  progress?: TaskProgress;
  /** Resumable queue payload. Currently supports shell commands. */
  queue?: TaskQueueSpec;
  attempts?: number;
  maxAttempts?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface TaskProgress {
  type: TaskType;
  percent?: number;
  message?: string;
  lastUpdate: number;
}

export interface TaskQueueSpec {
  kind: "shell";
  command: string;
  workdir: string;
  timeoutMs?: number;
}

// ── Task Manager ─────────────────────────────────────────────

export class TaskManager {
  private tasks: Map<string, TaskRecord> = new Map();
  private taskHistory: TaskRecord[] = []; // completed/failed/killed
  private maxHistory = 100;
  private dataFile: string | null;
  private workers: Map<string, ChildProcess> = new Map();

  constructor(dataFile = defaultTaskStoreFile()) {
    this.dataFile = dataFile;
    this.load();
  }

  createTask(
    type: TaskType,
    description: string,
    options?: {
      toolUseId?: string;
      agentId?: string;
      queue?: TaskQueueSpec;
      attempts?: number;
      maxAttempts?: number;
      outputFile?: string;
    },
  ): TaskRecord {
    const id = generateTaskId(type);
    const task: TaskRecord = {
      id,
      type,
      status: "pending",
      description,
      toolUseId: options?.toolUseId,
      agentId: options?.agentId,
      queue: options?.queue,
      attempts: options?.attempts,
      maxAttempts: options?.maxAttempts,
      outputFile: options?.outputFile,
      startTime: Date.now(),
      notified: false,
    };
    this.tasks.set(id, task);
    this.persist();
    return task;
  }

  enqueueShellTask(
    description: string,
    command: string,
    options?: { workdir?: string; timeoutMs?: number; maxAttempts?: number },
  ): TaskRecord {
    const policy = checkCommand(command);
    if (policy.decision === "deny") {
      throw new Error(`Command blocked by policy: ${policy.justification}`);
    }
    const task = this.createTask("bash", description, {
      queue: {
        kind: "shell",
        command,
        workdir: options?.workdir || ".",
        timeoutMs: options?.timeoutMs,
      },
      attempts: 0,
      maxAttempts: Math.max(1, options?.maxAttempts || 1),
      outputFile: this.taskOutputFile(),
    });
    this.runQueue();
    return task;
  }

  startTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") return false;
    task.status = "running";
    task.startTime = Date.now();
    this.persist();
    return true;
  }

  completeTask(taskId: string, output?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isActiveStatus(task.status)) return false;
    task.status = "completed";
    task.endTime = Date.now();
    if (output) task.output = output;
    this.archiveTask(task);
    this.persist();
    return true;
  }

  failTask(taskId: string, error?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isActiveStatus(task.status)) return false;
    task.status = "failed";
    task.endTime = Date.now();
    if (error) task.output = error;
    this.archiveTask(task);
    this.persist();
    return true;
  }

  killTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalStatus(task.status)) return false;
    const worker = this.workers.get(taskId);
    if (worker) {
      killChildProcessGroup(worker);
      this.workers.delete(taskId);
    }
    task.status = "killed";
    task.endTime = Date.now();
    this.archiveTask(task);
    this.persist();
    return true;
  }

  updateProgress(taskId: string, progress: TaskProgress): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isActiveStatus(task.status)) return false;
    task.progress = { ...progress, lastUpdate: Date.now() };
    this.persist();
    return true;
  }

  setNotified(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.notified = true;
    this.persist();
  }

  private archiveTask(task: TaskRecord): void {
    this.tasks.delete(task.id);
    this.taskHistory.push(task);
    if (this.taskHistory.length > this.maxHistory) {
      this.taskHistory = this.taskHistory.slice(-this.maxHistory);
    }
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  getActiveTasks(): TaskRecord[] {
    return [...this.tasks.values()].filter(t => isActiveStatus(t.status));
  }

  getTasksByType(type: TaskType): TaskRecord[] {
    return [...this.tasks.values()].filter(t => t.type === type);
  }

  getHistory(): TaskRecord[] {
    return [...this.taskHistory];
  }

  getTaskStats(): TaskStats {
    const active = this.getActiveTasks();
    const byType: Partial<Record<TaskType, number>> = {};
    for (const t of active) {
      byType[t.type] = (byType[t.type] || 0) + 1;
    }
    return {
      active: active.length,
      total: this.taskHistory.length + active.length,
      completed: this.taskHistory.filter(t => t.status === "completed").length,
      failed: this.taskHistory.filter(t => t.status === "failed").length,
      killed: this.taskHistory.filter(t => t.status === "killed").length,
      byType,
    };
  }

  clear(): void {
    for (const [taskId, worker] of this.workers) {
      killChildProcessGroup(worker);
      this.workers.delete(taskId);
    }
    this.tasks.clear();
    this.taskHistory = [];
    this.persist();
  }

  private load(): void {
    if (!this.dataFile) return;
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, "utf-8")) as { active?: TaskRecord[]; history?: TaskRecord[] };
      for (const task of raw.active || []) {
        if (task.queue && isActiveStatus(task.status)) {
          task.status = "pending";
          task.endTime = undefined;
          task.output = task.output ? `${task.output}\nRequeued after process restart` : "Requeued after process restart";
          this.tasks.set(task.id, task);
        } else if (task.status === "pending" || task.status === "running") {
          task.status = "killed";
          task.endTime = Date.now();
          task.output = task.output ? `${task.output}\nInterrupted by process restart` : "Interrupted by process restart";
          this.taskHistory.push(task);
        } else {
          this.taskHistory.push(task);
        }
      }
      this.taskHistory.push(...(raw.history || []));
      this.taskHistory = this.taskHistory.slice(-this.maxHistory);
      queueMicrotask(() => this.runQueue());
    } catch {
      // no persisted state yet
    }
  }

  private persist(): void {
    if (!this.dataFile) return;
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true });
      writeFileSync(this.dataFile, JSON.stringify({
        active: [...this.tasks.values()],
        history: this.taskHistory.slice(-this.maxHistory),
      }, null, 2), "utf-8");
    } catch {
      // keep memory state if persistence fails
    }
  }

  private runQueue(): void {
    for (const task of this.tasks.values()) {
      if (!task.queue || task.status !== "pending" || this.workers.has(task.id)) continue;
      this.startQueuedShellTask(task);
    }
  }

  private startQueuedShellTask(task: TaskRecord): void {
    if (!task.queue || task.queue.kind !== "shell") return;
    const spec = task.queue;
    task.status = "running";
    task.startTime = Date.now();
    task.endTime = undefined;
    task.attempts = (task.attempts || 0) + 1;
    task.output = appendTaskOutput(task.output, `$ ${spec.command}\n`);
    this.persist();

    try {
      const proc = spawn("bash", ["-c", spec.command], {
        cwd: spec.workdir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env },
        timeout: spec.timeoutMs,
      });
      this.workers.set(task.id, proc);
      const append = (prefix: string, chunk: Buffer) => {
        task.output = appendTaskOutput(task.output, prefix + chunk.toString("utf-8"));
        if (task.outputFile) {
          try {
            mkdirSync(dirname(task.outputFile), { recursive: true });
            appendFileSync(task.outputFile, prefix + chunk.toString("utf-8"), "utf-8");
          } catch {
            // keep in-memory/persisted output if artifact write fails
          }
        }
        this.persist();
      };
      proc.stdout.on("data", data => append("", data));
      proc.stderr.on("data", data => append("[stderr] ", data));
      proc.on("error", error => {
        this.workers.delete(task.id);
        this.finishQueuedTask(task, 1, null, `Error: ${error.message}`);
      });
      proc.on("close", (code, signal) => {
        this.workers.delete(task.id);
        if (task.status === "killed") return;
        this.finishQueuedTask(task, code ?? null, signal);
      });
    } catch (error: any) {
      this.finishQueuedTask(task, 1, null, `Error: ${error.message}`);
    }
  }

  private finishQueuedTask(task: TaskRecord, code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    task.exitCode = code;
    task.signal = signal;
    if (error) task.output = appendTaskOutput(task.output, error);
    if (task.output) {
      const artifact = createArtifact({
        kind: "task_log",
        name: `${task.id}.log`,
        content: task.output,
        extension: ".log",
        metadata: { task_id: task.id, command: task.queue?.command, workdir: task.queue?.workdir },
      });
      task.artifactIds = [...new Set([...(task.artifactIds || []), artifact.id])];
      linkArtifact(artifact.id, "task", task.id, { status: code === 0 ? "completed" : "failed" });
    }
    if (code === 0) {
      this.completeTask(task.id);
      return;
    }
    if ((task.attempts || 0) < (task.maxAttempts || 1)) {
      task.status = "pending";
      task.output = appendTaskOutput(task.output, `\nRetrying queued task (${task.attempts}/${task.maxAttempts})\n`);
      this.persist();
      queueMicrotask(() => this.runQueue());
      return;
    }
    this.failTask(task.id, appendTaskOutput(task.output, `[exit code: ${code ?? "null"}${signal ? `, signal: ${signal}` : ""}]`));
  }

  private taskOutputFile(): string | undefined {
    if (!this.dataFile) return undefined;
    return join(dirname(this.dataFile), "artifacts", `${generateTaskId("background")}.log`);
  }
}

export interface TaskStats {
  active: number;
  total: number;
  completed: number;
  failed: number;
  killed: number;
  byType: Partial<Record<TaskType, number>>;
}

// Singleton
let taskManagerInstance: TaskManager | null = null;
export function getTaskManager(): TaskManager {
  if (!taskManagerInstance) taskManagerInstance = new TaskManager();
  return taskManagerInstance;
}
export function clearTaskManager(): void {
  taskManagerInstance?.clear();
  taskManagerInstance = null;
}

export function defaultTaskStoreFile(): string {
  if (process.env.DEEPCODE_TASKS_DIR) return join(resolve(process.env.DEEPCODE_TASKS_DIR), "tasks.json");
  if (process.env.DEEPSEEK_TASKS_DIR) return join(resolve(process.env.DEEPSEEK_TASKS_DIR), "tasks.json");
  const xdg = process.env.XDG_DATA_HOME || resolve(process.env.HOME || "~", ".local", "share");
  return join(xdg, "deepseek", "tasks", "tasks.json");
}

export function clearPersistentTaskStateForTests(): void {
  clearTaskManager();
  try { rmSync(dirname(defaultTaskStoreFile()), { recursive: true, force: true }); } catch { /* ignore */ }
}

function appendTaskOutput(existing: string | undefined, next: string): string {
  const combined = `${existing || ""}${next}`;
  const maxChars = 200_000;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}

function killChildProcessGroup(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  }
}
