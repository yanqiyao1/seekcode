/** Request handlers for HTTP/SSE server using Hono. */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { loadConfig, type Config } from "../config.js";
import { DeepSeekClient } from "../client/deepseek.js";
import { getRegistry } from "../tools/registry.js";
import { getMode } from "../modes/base.js";
import { Engine } from "../engine/loop.js";
import { ConversationHistory } from "../session/history.js";
import { createSession } from "../session/types.js";
import { buildSystemPrompt, buildToolsDescription } from "../engine/context.js";
import { injectSkills, SkillRegistry } from "../engine/skills.js";
import {
  appendEvent,
  appendRuntimeItem,
  createRuntimeRecord,
  createTurn,
  deleteRuntimeRecordBySession,
  forkRuntimeThread,
  getRuntimeRecord,
  getRuntimeRecordBySession,
  listRuntimeRecords,
  replayRuntimeEvents,
  replayRuntimeItems,
  subscribeRuntimeEvents,
  updateRuntimeThread,
  updateTurn,
  type RuntimeEvent,
} from "./runtime-store.js";
import { registerFileTools } from "../tools/file-ops.js";
import { registerShellTool } from "../tools/shell.js";
import { registerGitTools } from "../tools/git.js";
import { registerWebTools } from "../tools/web.js";
import { registerPatchTool } from "../tools/patch.js";
import { registerThinkTool } from "../tools/think.js";
import { registerRLMTool } from "../tools/rlm-query.js";
import { registerSubAgentTool } from "../tools/sub-agent.js";
import { registerPlanTools } from "../tools/plan.js";
import { registerGoalTools } from "../tools/goal.js";
import { registerToolSearchTool } from "../tools/tool-search.js";
import { registerTaskTools } from "../tools/tasks.js";
import { registerDiagnosticsTools } from "../tools/diagnostics.js";
import { registerArtifactTools } from "../tools/artifacts.js";

// Ensure tools registered
let toolsReadyKey = "";
function ensureTools(config?: Config) {
  const key = JSON.stringify(config?.web || {});
  if (toolsReadyKey === key && getRegistry().size > 0) return;
  toolsReadyKey = key;
  const registry = getRegistry();
  if (registry.size > 0) {
    registerWebTools(config?.web);
    return;
  }
  registerFileTools();
  registerShellTool();
  registerGitTools();
  registerWebTools(config?.web);
  registerPatchTool();
  registerThinkTool();
  registerRLMTool();
  registerSubAgentTool();
  registerPlanTools();
  registerGoalTools();
  registerToolSearchTool();
  registerTaskTools();
  registerArtifactTools();
  registerDiagnosticsTools();
}

export async function health(c: Context) {
  return c.json({ status: "ok", version: "0.1.0" });
}

export async function createSessionHandler(c: Context) {
  const cfg = loadConfig();
  const session = createSession({ model: cfg.model, mode: cfg.mode });
  const record = createRuntimeRecord(cfg, session);
  ensureTools(cfg);
  record.history.addSystem(injectSkills(
    buildSystemPrompt(cfg, session.workspace_path || process.cwd(), buildToolsDescription(getRegistry().listAll())),
    session.workspace_path || process.cwd(),
    cfg.skills_dir,
  ));
  return c.json({ session_id: session.id, thread_id: record.thread.id });
}

export async function getSessionHandler(c: Context) {
  const id = c.req.param("session_id") || "";
  const record = getRuntimeRecordBySession(id);
  if (!record) return c.json({ error: "Session not found" }, 404);
  return c.json({ id: record.session.id, thread_id: record.thread.id, mode: record.session.mode, model: record.session.model, message_count: record.session.messages.length });
}

export async function listSessionsHandler(c: Context) {
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") || 50), 200));
  const search = (c.req.query("search") || "").toLowerCase();
  const sessions = listRuntimeRecords()
    .filter(record => !search || record.session.title.toLowerCase().includes(search) || record.session.id.includes(search))
    .slice(0, limit)
    .map(record => ({
      id: record.session.id,
      thread_id: record.thread.id,
      title: record.session.title,
      updated_at: record.thread.updated_at,
      mode: record.session.mode,
      model: record.session.model,
      message_count: record.session.messages.length,
    }));
  return c.json({ sessions });
}

export async function deleteSessionHandler(c: Context) {
  const id = c.req.param("session_id") || "";
  return deleteRuntimeRecordBySession(id) ? c.json({ deleted: true, id }) : c.json({ error: "Session not found" }, 404);
}

export async function resumeSessionThreadHandler(c: Context) {
  const id = c.req.param("session_id") || "";
  const record = getRuntimeRecordBySession(id);
  if (!record) return c.json({ error: "Session not found" }, 404);
  return c.json({ thread_id: record.thread.id, session_id: id, summary: `Resumed session ${id} into thread ${record.thread.id}` });
}

export async function listThreadsHandler(c: Context) {
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") || 50), 200));
  const includeArchived = c.req.query("include_archived") === "true";
  const threads = listRuntimeRecords()
    .filter(record => includeArchived || !record.thread.archived)
    .slice(0, limit)
    .map(record => record.thread);
  return c.json({ threads });
}

export async function createThreadHandler(c: Context) {
  const cfg = loadConfig();
  const body = await c.req.json().catch(() => ({}));
  const session = createSession({
    model: body.model || cfg.model,
    mode: body.mode || cfg.mode,
    workspace_path: body.workspace || process.cwd(),
  });
  const record = createRuntimeRecord(cfg, session);
  ensureTools(cfg);
  record.history.addSystem(injectSkills(
    buildSystemPrompt(cfg, session.workspace_path, buildToolsDescription(getRegistry().listAll())),
    session.workspace_path,
    cfg.skills_dir,
  ));
  return c.json({ thread: record.thread });
}

export async function getThreadHandler(c: Context) {
  const record = getRuntimeRecord(c.req.param("thread_id") || "");
  if (!record) return c.json({ error: "Thread not found" }, 404);
  return c.json({ thread: record.thread, turns: record.turns, items: record.items, session: record.session });
}

export async function threadItemsHandler(c: Context) {
  const record = getRuntimeRecord(c.req.param("thread_id") || "");
  if (!record) return c.json({ error: "Thread not found" }, 404);
  const sinceSeq = Number(c.req.query("since_seq") || 0);
  return c.json({ items: replayRuntimeItems(record.thread.id, sinceSeq) });
}

export async function updateThreadHandler(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  if (typeof body.mode === "string") patch.mode = body.mode;
  if (typeof body.model === "string") patch.model = body.model;
  if (typeof body.workspace === "string") patch.workspace = body.workspace;
  const thread = updateRuntimeThread(c.req.param("thread_id") || "", patch as any);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  return c.json({ thread });
}

export async function forkThreadHandler(c: Context) {
  const fork = forkRuntimeThread(c.req.param("thread_id") || "");
  if (!fork) return c.json({ error: "Thread not found" }, 404);
  return c.json({ thread: fork.thread, session_id: fork.session.id });
}

export async function threadEventsHandler(c: Context) {
  const record = getRuntimeRecord(c.req.param("thread_id") || "");
  if (!record) return c.json({ error: "Thread not found" }, 404);
  const sinceSeq = Number(c.req.query("since_seq") || 0);
  if ((c.req.header("accept") || "").includes("text/event-stream")) {
    return streamSSE(c, async (stream) => {
      let closed = false;
      let close: () => void = () => { closed = true; };
      const closedPromise = new Promise<void>(resolve => {
        close = () => {
          if (closed) return;
          closed = true;
          resolve();
        };
      });
      stream.onAbort(close);
      await stream.write(": connected\n\n");
      const pending: RuntimeEvent[] = [];
      let liveReady = false;
      let writeChain = Promise.resolve();
      let lastSentSeq = sinceSeq;
      const writeEvent = (event: RuntimeEvent): Promise<void> => {
        writeChain = writeChain.then(async () => {
          if (closed || event.seq <= lastSentSeq) return;
          await stream.writeSSE({
            id: String(event.seq),
            event: event.event,
            data: JSON.stringify(event),
          });
          lastSentSeq = Math.max(lastSentSeq, event.seq);
        });
        return writeChain;
      };
      const unsubscribe = subscribeRuntimeEvents(record.thread.id, async (event) => {
        if (event.seq <= lastSentSeq) return;
        if (!liveReady) {
          pending.push(event);
          return;
        }
        await writeEvent(event);
      });
      try {
        for (const event of replayRuntimeEvents(record.thread.id, sinceSeq)) {
          await writeEvent(event);
        }
        while (pending.length) {
          const next = pending.shift();
          if (next) await writeEvent(next);
        }
        liveReady = true;
        const heartbeat = setInterval(() => {
          if (!closed) void stream.write(": keepalive\n\n");
        }, 25_000);
        await closedPromise.finally(() => clearInterval(heartbeat));
      } finally {
        close();
        unsubscribe();
      }
    });
  }
  return c.json({ events: replayRuntimeEvents(record.thread.id, sinceSeq) });
}

export async function interruptTurnHandler(c: Context) {
  const record = getRuntimeRecord(c.req.param("thread_id") || "");
  if (!record) return c.json({ error: "Thread not found" }, 404);
  const turn = record.turns.find(item => item.id === c.req.param("turn_id"));
  if (!turn) return c.json({ error: "Turn not found" }, 404);
  if (!["queued", "in_progress"].includes(turn.status)) {
    return c.json({ interrupted: false, turn, reason: `Turn is already ${turn.status}` }, 409);
  }
  record.abortController?.abort();
  record.activeEngine?.interrupt();
  appendEvent(record, "turn.interrupt_requested", { turn_id: turn.id, reason: "API request" }, turn.id);
  appendRuntimeItem(record, "interrupt", { turn_id: turn.id, reason: "API request" }, { turnId: turn.id });
  updateTurn(record, turn, "interrupted", { error: "Interrupted by API request", interrupted_at: new Date().toISOString() });
  return c.json({ interrupted: true, turn });
}

export async function listToolsHandler(c: Context) {
  ensureTools(loadConfig());
  const tools = getRegistry().listAll();
  return c.json({ tools: tools.map(t => ({ name: t.name, description: t.description, category: t.category })) });
}

export async function listSkillsHandler(c: Context) {
  const cfg = loadConfig();
  const workspace = c.req.query("workspace") || process.cwd();
  const registry = SkillRegistry.discover({ workspaceDir: workspace, skillsDir: cfg.skills_dir });
  return c.json({
    skills: registry.list().map(skill => ({
      name: skill.name,
      description: skill.description,
      location: skill.location,
      scope: skill.scope,
      installed: skill.installed,
      trusted: skill.trusted,
      system: skill.system,
    })),
    warnings: registry.warnings(),
  });
}

export async function chatHandler(c: Context) {
  const id = c.req.param("session_id") || "";
  const record = getRuntimeRecordBySession(id);
  if (!record) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json();
  const message = body.message;
  if (!message) return c.json({ error: "message required" }, 400);

  ensureTools(record.config);

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController();
    try {
      const client = new DeepSeekClient({
        apiKey: record.config.api_key,
        baseUrl: record.config.base_url,
        model: record.config.model,
        provider: record.config.provider,
      });
      record.abortController = abortController;
      const turn = createTurn(record, message);
      appendRuntimeItem(record, "turn_input", { message }, { turnId: turn.id });
      updateTurn(record, turn, "in_progress");
      const tools = getRegistry();
      const engine = new Engine(record.config, record.session, record.history, client, tools);
      record.activeEngine = engine;
      const mode = getMode(record.config.mode);
      const result = await engine.runTurn(message, mode, {
        onThinking: async (text) => {
          appendEvent(record, "thinking", { text }, turn.id);
          await stream.writeSSE({ event: "thinking", data: JSON.stringify({ text }) });
        },
        onContent: async (text) => {
          appendEvent(record, "content", { text }, turn.id);
          await stream.writeSSE({ event: "content", data: JSON.stringify({ text }) });
        },
        onToolCallStart: async (name) => {
          appendEvent(record, "tool_call", { name }, turn.id);
          await stream.writeSSE({ event: "tool_call", data: JSON.stringify({ name }) });
        },
        onToolExecuted: async (name, preview) => {
          appendEvent(record, "tool_result", { name, preview }, turn.id);
          await stream.writeSSE({ event: "tool_result", data: JSON.stringify({ name, preview }) });
        },
        onContextIntervention: async (intervention) => {
          appendEvent(record, "context_intervention", intervention, turn.id);
          await stream.writeSSE({ event: "context_intervention", data: JSON.stringify(intervention) });
        },
        onRuntimeItem: async (item) => {
          appendRuntimeItem(record, item.type, item.data, { turnId: turn.id, artifactIds: item.artifact_ids });
        },
        requestApproval: async (toolName, args) => {
          await stream.writeSSE({ event: "approval_required", data: JSON.stringify({ tool: toolName, args }) });
          return false;
        },
      }, { signal: abortController.signal });
      if (abortController.signal.aborted) {
        appendRuntimeItem(record, "interrupt", { turn_id: turn.id, reason: "abort signal" }, { turnId: turn.id });
        updateTurn(record, turn, "interrupted", { error: "Interrupted by API request", interrupted_at: new Date().toISOString() });
        await stream.writeSSE({ event: "interrupted", data: JSON.stringify({ turn_id: turn.id }) });
        return;
      }
      updateTurn(record, turn, "completed", { usage: result.usage });
      await stream.writeSSE({ event: "done", data: JSON.stringify({ usage: result.usage, iterations: result.iterations }) });
    } catch (e: any) {
      const latest = record.turns.at(-1);
      if (abortController.signal.aborted || isAbortError(e)) {
        if (latest && ["queued", "in_progress"].includes(latest.status)) {
          appendRuntimeItem(record, "interrupt", { turn_id: latest.id, reason: "abort signal" }, { turnId: latest.id });
          updateTurn(record, latest, "interrupted", { error: "Interrupted by API request", interrupted_at: new Date().toISOString() });
        }
        await stream.writeSSE({ event: "interrupted", data: JSON.stringify({ turn_id: latest?.id }) });
        return;
      }
      if (latest && latest.status !== "interrupted") updateTurn(record, latest, "failed", { error: e.message });
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: e.message }) });
    } finally {
      record.abortController = undefined;
      record.activeEngine = undefined;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}
