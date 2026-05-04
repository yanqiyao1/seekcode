/** Durable task tools backed by the process task lifecycle manager. */

import { getTaskManager, type TaskType } from "../engine/task-lifecycle.js";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

function parseType(value: unknown): TaskType {
  const type = String(value || "background");
  if (["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"].includes(type)) {
    return type as TaskType;
  }
  return "background";
}

async function taskCreate(args: Record<string, unknown>): Promise<string> {
  const description = String(args.description || args.prompt || "").trim();
  if (!description) return "Error: description is required.";
  const command = String(args.command || "").trim();
  try {
    const task = command
      ? getTaskManager().enqueueShellTask(description, command, {
        workdir: String(args.workdir || "."),
        timeoutMs: args.timeout ? Number(args.timeout) : undefined,
        maxAttempts: args.max_attempts ? Number(args.max_attempts) : undefined,
      })
      : getTaskManager().createTask(parseType(args.type), description);
    if (!command) getTaskManager().startTask(task.id);
    return JSON.stringify({ id: task.id, status: task.status, type: task.type, description: task.description, queue: task.queue }, null, 2);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function taskList(): Promise<string> {
  const manager = getTaskManager();
  const active = manager.getActiveTasks();
  const history = manager.getHistory();
  if (!active.length && !history.length) return "No tasks.";
  return JSON.stringify({
    active,
    history: history.slice(-20),
    stats: manager.getTaskStats(),
  }, null, 2);
}

async function taskRead(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.task_id || "");
  if (!id) return "Error: id is required.";
  const manager = getTaskManager();
  const task = manager.getTask(id) || manager.getHistory().find(item => item.id === id);
  return task ? JSON.stringify(task, null, 2) : `Error: task not found: ${id}`;
}

async function taskCancel(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.task_id || "");
  if (!id) return "Error: id is required.";
  return getTaskManager().killTask(id) ? `Cancelled task ${id}.` : `Error: active task not found: ${id}`;
}

async function taskComplete(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.task_id || "");
  if (!id) return "Error: id is required.";
  return getTaskManager().completeTask(id, args.output ? String(args.output) : undefined)
    ? `Completed task ${id}.`
    : `Error: active task not found: ${id}`;
}

async function taskFail(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.task_id || "");
  if (!id) return "Error: id is required.";
  return getTaskManager().failTask(id, args.error ? String(args.error) : undefined)
    ? `Failed task ${id}.`
    : `Error: active task not found: ${id}`;
}

async function taskGateRun(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command || "");
  if (!command) return "Error: command is required.";
  const { getRegistry } = await import("./registry.js");
  const bash = getRegistry().lookup("bash");
  if (!bash) return "Error: bash tool is unavailable.";
  const started = Date.now();
  const output = await bash.execute({ command, workdir: args.workdir || ".", timeout: args.timeout || 120000 });
  const passed = /\[exit code: 0\]\s*$/m.test(output);
  return JSON.stringify({
    command,
    workdir: args.workdir || ".",
    passed,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(3)),
    output,
  }, null, 2);
}

export function registerTaskTools(): void {
  const registry = getRegistry();
  registry.register({
    name: "task_create",
    description: "Create a durable task record for long-running agent work.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        type: { type: "string", enum: ["bash", "agent", "remote_agent", "workflow", "monitor", "sub_task", "background"], default: "background" },
        command: { type: "string", description: "Optional shell command to enqueue and execute durably." },
        workdir: { type: "string", default: "." },
        timeout: { type: "integer", default: 120000 },
        max_attempts: { type: "integer", default: 1 },
      },
      required: ["description"],
    },
    execute: taskCreate,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
  });
  registry.register({
    name: "task_list",
    description: "List active and recently completed durable tasks.",
    parameters: { type: "object", properties: {} },
    execute: taskList,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
  });
  registry.register({
    name: "task_read",
    description: "Read a durable task by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: taskRead,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
  });
  registry.register({
    name: "task_cancel",
    description: "Cancel an active durable task by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: taskCancel,
    permission: PermissionLevel.ASK,
    category: "task",
    parallelOk: true,
  });
  registry.register({
    name: "task_complete",
    description: "Mark an active durable task as completed.",
    parameters: { type: "object", properties: { id: { type: "string" }, output: { type: "string" } }, required: ["id"] },
    execute: taskComplete,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
  });
  registry.register({
    name: "task_fail",
    description: "Mark an active durable task as failed.",
    parameters: { type: "object", properties: { id: { type: "string" }, error: { type: "string" } }, required: ["id"] },
    execute: taskFail,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "task",
    parallelOk: true,
  });
  registry.register({
    name: "task_gate_run",
    description: "Run a verification command and return structured gate evidence.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string", default: "." },
        timeout: { type: "integer", default: 120000 },
      },
      required: ["command"],
    },
    execute: taskGateRun,
    permission: PermissionLevel.ASK,
    category: "task",
    parallelOk: false,
  });
}
