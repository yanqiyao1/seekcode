import { getTaskManager } from "../engine/task-lifecycle.js";
import { formatJob, getJobManager } from "../tools/jobs.js";
import { formatTodoState } from "../tools/plan.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";

export const tasksCommand: SlashCommandHandler = ({ parts, cmd, runtime, write }) => {
  const tm = getTaskManager();
  const subcmd = parts[1];
  const id = parts[2];
  if (runtime.liveReadonly && ["cancel", "complete"].includes(subcmd || "")) {
    write(p.warning(`/${cmd.slice(1)} ${subcmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
    return;
  }
  if (subcmd === "read" && id) {
    const task = tm.getTask(id) || tm.getHistory().find(item => item.id === id);
    write(task ? JSON.stringify(task, null, 2) : p.error(`Task not found: ${id}`));
    return;
  }
  if (subcmd === "cancel" && id) {
    write(tm.killTask(id) ? p.success(`Cancelled task ${id}.`) : p.error(`Task not active: ${id}`));
    return;
  }
  if (subcmd === "complete" && id) {
    write(tm.completeTask(id, parts.slice(3).join(" ") || undefined) ? p.success(`Completed task ${id}.`) : p.error(`Task not active: ${id}`));
    return;
  }
  const checklist = formatTodoState();
  if (checklist) write(checklist);
  const stats = tm.getTaskStats();
  write(p.blueBold(`Durable tasks: ${stats.active} active, ${stats.total} total`));
  write(`  Completed: ${stats.completed} | Failed: ${stats.failed} | Killed: ${stats.killed}`);
  if (Object.keys(stats.byType).length) {
    write("  By type: " + Object.entries(stats.byType).map(([k, v]) => `${k}:${v}`).join(" "));
  }
  const active = tm.getActiveTasks();
  for (const t of active.slice(0, 10)) {
    const dur = ((Date.now() - t.startTime) / 1000).toFixed(0);
    write(`  ${t.status === "running" ? "◎" : "○"} [${t.type}] ${t.description} (${dur}s)`);
  }
};

export const jobsCommand: SlashCommandHandler = ({ parts, cmd, runtime, write }) => {
  const subcmd = parts[1];
  const id = parts[2];
  if (runtime.liveReadonly && ["cancel", "prune"].includes(subcmd || "")) {
    write(p.warning(`/${cmd.slice(1)} ${subcmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
    return;
  }
  if (subcmd === "cancel" && id) {
    write(getJobManager().cancel(id) ? p.success(`Cancelled job ${id}.`) : p.error(`Job not running: ${id}`));
    return;
  }
  if (subcmd === "show" && id) {
    const job = getJobManager().get(id);
    write(job ? formatJob(job, 4000) : p.error(`Job not found: ${id}`));
    return;
  }
  if (subcmd === "prune") {
    write(p.success(`Pruned ${getJobManager().prune()} old job(s).`));
    return;
  }
  const jobs = getJobManager().list();
  if (!jobs.length) {
    write(p.dim("No background jobs."));
    return;
  }
  for (const job of jobs.slice(0, 10)) {
    write(formatJob(job, 800));
    write("");
  }
};

