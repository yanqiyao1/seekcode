import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearHooks, fireHooks, registerHook } from "../src/engine/hooks.js";
import { clearPersistentTaskStateForTests, getTaskManager, TaskManager } from "../src/engine/task-lifecycle.js";
import { MCPClient } from "../src/mcp/client.js";
import { parseSSEFrames } from "../src/server/transport.js";
import { clearJobManagerForTests, getJobManager, reloadJobManagerForTests } from "../src/tools/jobs.js";
import { getRegistry } from "../src/tools/registry.js";
import { registerShellTool } from "../src/tools/shell.js";
import { registerTaskTools } from "../src/tools/tasks.js";

let tmp: string;
let oldTasksDir: string | undefined;
let oldJobsDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-runtime-"));
  oldTasksDir = process.env.DEEPCODE_TASKS_DIR;
  oldJobsDir = process.env.DEEPCODE_JOBS_DIR;
  process.env.DEEPCODE_TASKS_DIR = join(tmp, "tasks");
  process.env.DEEPCODE_JOBS_DIR = join(tmp, "jobs");
  clearJobManagerForTests();
  getRegistry().clear();
  clearPersistentTaskStateForTests();
  clearHooks();
});

afterEach(() => {
  clearHooks();
  getRegistry().clear();
  clearJobManagerForTests();
  if (oldTasksDir === undefined) delete process.env.DEEPCODE_TASKS_DIR;
  else process.env.DEEPCODE_TASKS_DIR = oldTasksDir;
  if (oldJobsDir === undefined) delete process.env.DEEPCODE_JOBS_DIR;
  else process.env.DEEPCODE_JOBS_DIR = oldJobsDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("shell tool", () => {
  it("terminates commands that exceed timeout", async () => {
    registerShellTool();

    const start = Date.now();
    const result = await getRegistry().lookup("bash")!.execute({ command: "sleep 2", timeout: 50, workdir: tmp });

    expect(Date.now() - start).toBeLessThan(1500);
    expect(result).toMatch(/timed out|signal|exit code/i);
  });

  it("kills foreground shell process groups on timeout", async () => {
    registerShellTool();
    const pidFile = join(tmp, "foreground-child.pid");

    const result = await getRegistry().lookup("bash")!.execute({
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      timeout: 100,
      workdir: tmp,
    });
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());

    expect(result).toMatch(/timed out|signal/i);
    await waitFor(() => !isPidAlive(childPid), 2500);
  });

  it("starts, polls, and cancels background shell jobs", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({ command: "printf hello && sleep 1", workdir: tmp });
    const id = started.match(/job_[a-z0-9_]+/)?.[0];

    expect(id).toBeTruthy();
    expect(await getRegistry().lookup("task_shell_wait")!.execute({ id })).toContain("hello");
    expect(await getRegistry().lookup("exec_shell_cancel")!.execute({ id })).toMatch(/Cancelled|not running/);
  });

  it("kills background job process groups when cancelled", async () => {
    registerShellTool();
    const pidFile = join(tmp, "background-child.pid");

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: `bash -lc 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait'`,
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, "utf-8").trim());

    expect(await getRegistry().lookup("exec_shell_cancel")!.execute({ id })).toContain("Cancelled");
    await waitFor(() => !isPidAlive(childPid), 2500);
  });

  it("times out background jobs and records failure output", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "echo start; sleep 5; echo never",
      workdir: tmp,
      timeout: 100,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    const output = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(text => text.includes("status: failed") ? text : ""), 2500);

    expect(output).toContain("start");
    expect(output).toMatch(/timeout|exit_code: 124|exit_code: 137/i);
    expect(getJobManager().get(id)?.output).not.toContain("never");
  });

  it("persists background job logs and reattaches running jobs after restart", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "printf persisted && sleep 1",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("\npersisted")));
    const before = getJobManager().get(id)!;

    expect(before.logFile).toBeTruthy();
    expect(existsSync(before.logFile!)).toBe(true);
    expect(readFileSync(before.logFile!, "utf-8")).toContain("persisted");

    reloadJobManagerForTests();
    const after = getJobManager().get(id);

    expect(after?.status).toBe("running");
    expect(after?.reattachable).toBe(true);
    expect(after?.output).toContain("persisted");
  });

  it("reattaches stdin to a running job after manager restart", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "bash -lc 'echo ready; IFS= read -r value; echo got:$value'",
      workdir: tmp,
      pty: false,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("ready")));

    reloadJobManagerForTests();
    expect(await getRegistry().lookup("exec_shell_interact")!.execute({ id, input: "after-restart\n" })).toContain("Sent");
    const done = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("got:after-restart") ? output : ""));

    expect(done).toContain("status: completed");
  });

  it("starts background jobs with PTY support by default", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({ command: "printf pty-ok", workdir: tmp });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    const output = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(text => text.includes("pty-ok") ? text : ""));

    expect(output).toContain("pty: yes");
    expect(output).toContain("pty-ok");
  });

  it("supports stdin interaction for PTY jobs", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({
      command: "bash -lc 'echo pty-ready; IFS= read -r value; echo pty-got:$value'",
      workdir: tmp,
      pty: true,
    });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("pty-ready")));

    expect(await getRegistry().lookup("exec_shell_interact")!.execute({ id, input: "catnip\n" })).toContain("Sent");
    const done = await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("pty-got:catnip") ? output : ""), 2500);

    expect(done).toContain("status: completed");
  });

  it("reloads only job metadata and ignores status helper json files", async () => {
    registerShellTool();

    const started = await getRegistry().lookup("task_shell_start")!.execute({ command: "printf done", workdir: tmp, pty: false });
    const id = started.match(/job_[a-z0-9_]+/)?.[0]!;
    await waitFor(() => getRegistry().lookup("task_shell_wait")!.execute({ id }).then(output => output.includes("status: completed")));

    reloadJobManagerForTests();
    const jobs = getJobManager().list();

    expect(jobs.map(job => job.id)).toEqual([id]);
    expect(jobs[0].status).toBe("completed");
  });
});

describe("task tools", () => {
  it("creates, lists, reads, completes, and persists durable tasks", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({ description: "Investigate bug" }));
    const listed = await getRegistry().lookup("task_list")!.execute({});
    const read = await getRegistry().lookup("task_read")!.execute({ id: created.id });
    const completed = await getRegistry().lookup("task_complete")!.execute({ id: created.id, output: "done" });
    const reloaded = getTaskManager().getHistory().find(task => task.id === created.id);

    expect(listed).toContain(created.id);
    expect(read).toContain("Investigate bug");
    expect(completed).toContain("Completed");
    expect(reloaded?.status).toBe("completed");
  });

  it("executes queued shell tasks and keeps completed artifacts", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Durable echo",
      command: "printf queued-task",
      workdir: tmp,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    });

    expect(done.output).toContain("queued-task");
    expect(done.outputFile && existsSync(done.outputFile)).toBe(true);
  });

  it("retries queued shell tasks up to max attempts", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Retry once",
      command: "if [ ! -f retry.marker ]; then touch retry.marker; echo first; exit 1; fi; echo second",
      workdir: tmp,
      max_attempts: 2,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "completed" ? task : null;
    }, 2500);

    expect(done.attempts).toBe(2);
    expect(done.output).toContain("Retrying queued task");
    expect(done.output).toContain("second");
  });

  it("marks timed-out queued shell tasks as failed", async () => {
    registerTaskTools();

    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      description: "Timeout task",
      command: "sleep 5",
      workdir: tmp,
      timeout: 100,
    }));
    const done = await waitFor(() => {
      const task = getTaskManager().getHistory().find(item => item.id === created.id);
      return task?.status === "failed" ? task : null;
    }, 2500);

    expect(done.signal || done.exitCode).toBeTruthy();
    expect(done.output).toMatch(/exit code|signal/i);
  });

  it("runs task verification gates with pass and fail evidence", async () => {
    registerShellTool();
    registerTaskTools();

    const passed = JSON.parse(await getRegistry().lookup("task_gate_run")!.execute({ command: "printf pass", workdir: tmp }));
    const failed = JSON.parse(await getRegistry().lookup("task_gate_run")!.execute({ command: "printf fail && exit 7", workdir: tmp }));

    expect(passed).toMatchObject({ passed: true });
    expect(passed.output).toContain("pass");
    expect(failed).toMatchObject({ passed: false });
    expect(failed.output).toContain("[exit code: 7]");
  });

  it("requeues resumable tasks after manager restart instead of killing them", async () => {
    const store = join(tmp, "tasks", "tasks.json");
    const manager = new TaskManager(store);
    const task = manager.createTask("bash", "Restartable", {
      queue: { kind: "shell", command: "printf resumed", workdir: tmp },
      attempts: 0,
      maxAttempts: 1,
    });
    manager.startTask(task.id);

    const reloaded = new TaskManager(store);
    const done = await waitFor(() => {
      const finished = reloaded.getHistory().find(item => item.id === task.id);
      return finished?.status === "completed" ? finished : null;
    });

    expect(done.output).toContain("resumed");
  });
});

describe("MCPClient", () => {
  it("rejects pending requests when stdio server exits", async () => {
    const server = join(tmp, "server.mjs");
    writeFileSync(server, "process.exit(0);\n");
    const client = new MCPClient({ name: "dead", transport: "stdio", command: process.execPath, args: [server], env: {} });

    await client.connect();

    await expect(client.initialize()).rejects.toThrow(/exited|closed|timed out/i);
  });
});

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 1500): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for condition");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

describe("SSE frame parser", () => {
  it("parses CRLF frames and preserves unfinished remainder", () => {
    const parsed = parseSSEFrames("event: content\r\ndata: hello\r\n\r\ndata: partial");

    expect(parsed.frames).toEqual([{ event: "content", data: "hello" }]);
    expect(parsed.remaining).toBe("data: partial");
  });

  it("ignores keepalive comments without dropping data frames that include comments", () => {
    const parsed = parseSSEFrames(": keepalive\n\nevent: msg\n: ignored\ndata: ok\n\n");

    expect(parsed.frames).toEqual([{ event: "msg", data: "ok" }]);
  });
});

describe("hooks", () => {
  it("aggregates hook messages and lets deny win", async () => {
    registerHook({ event: "PreToolUse", command: `${process.execPath} -e "console.log(JSON.stringify({decision:'continue', message:'first'}))"` });
    registerHook({ event: "PreToolUse", command: `${process.execPath} -e "console.log(JSON.stringify({decision:'deny', message:'blocked'}))"` });
    registerHook({ event: "PreToolUse", command: `${process.execPath} -e "console.log(JSON.stringify({decision:'approve', message:'late'}))"` });

    const result = await fireHooks("PreToolUse", { tool_name: "bash", tool_input: { command: "echo hi" }, cwd: tmp });

    expect(result.decision).toBe("deny");
    expect(result.message).toBe("blocked");
    expect(result.fired).toBe(2);
  });
});
