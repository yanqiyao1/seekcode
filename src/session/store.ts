/** Session persistence — JSON save/load. */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import type { Message, Session, ToolCall, Turn } from "./types.js";
import { createSession } from "./types.js";
import { deriveSessionTitle, refreshSessionTitle } from "./title.js";

function primarySessionsDir(): string {
  if (process.env.DEEPSEEK_SESSIONS_DIR) return resolve(process.env.DEEPSEEK_SESSIONS_DIR);
  const xdg = process.env.XDG_DATA_HOME || resolve(process.env.HOME || "~", ".local", "share");
  return join(xdg, "deepseek", "sessions");
}

function fallbackSessionsDir(): string {
  return resolve(process.cwd(), ".deepseek", "sessions");
}

function candidateSessionDirs(): string[] {
  return [...new Set([primarySessionsDir(), fallbackSessionsDir()])];
}

function safeSessionId(sessionId: unknown): string {
  return basename(String(sessionId || ""))
    .replace(/\.json$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 128);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function normalizeToolCall(raw: unknown): ToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : {};
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : typeof fn.name === "string" ? fn.name : "";
  const rawArgs = record.arguments ?? fn.arguments;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  if (!id && !name) return null;
  return { id, name, arguments: args };
}

function normalizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(record.role as string)) return null;

  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls.map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
    : null;

  return {
    role: record.role as Message["role"],
    content: stringOrNull(record.content),
    tool_calls: toolCalls && toolCalls.length ? toolCalls : null,
    tool_call_id: typeof record.tool_call_id === "string" ? record.tool_call_id : null,
    name: typeof record.name === "string" ? record.name : null,
    reasoning_content: typeof record.reasoning_content === "string" ? record.reasoning_content : null,
    is_error: typeof record.is_error === "boolean" ? record.is_error : null,
  };
}

function normalizeTurn(raw: unknown, index: number): Turn | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    index: numberOrZero(record.index) || index,
    user_message: typeof record.user_message === "string" ? record.user_message : "",
    assistant_messages: Array.isArray(record.assistant_messages)
      ? record.assistant_messages.map(normalizeMessage).filter((message): message is Message => !!message)
      : [],
    tool_calls: Array.isArray(record.tool_calls)
      ? record.tool_calls.map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => !!toolCall)
      : [],
    tool_results: Array.isArray(record.tool_results) ? record.tool_results.map((toolResult: unknown) => {
      const tr = (toolResult && typeof toolResult === "object" ? toolResult : {}) as Record<string, unknown>;
      return {
        tool_call_id: typeof tr.tool_call_id === "string" ? tr.tool_call_id : "",
        name: typeof tr.name === "string" ? tr.name : "",
        content: stringOrNull(tr.content) || "",
        is_error: !!tr.is_error,
      };
    }) : [],
    tokens_in: numberOrZero(record.tokens_in),
    tokens_out: numberOrZero(record.tokens_out),
    cost: numberOrZero(record.cost),
    duration_s: numberOrZero(record.duration_s),
    artifact_ids: Array.isArray(record.artifact_ids) ? record.artifact_ids.map(String).filter(Boolean) : [],
  };
}

function normalizeSession(data: unknown, fallbackId?: string): Session {
  const base = createSession();
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const messages = Array.isArray(record.messages)
    ? record.messages.map(normalizeMessage).filter((message): message is Message => !!message)
    : [];
  const session: Session = {
    ...base,
    id: safeSessionId(record.id) || fallbackId || base.id,
    title: typeof record.title === "string" ? record.title.trim() : "",
    created_at: typeof record.created_at === "string" ? record.created_at : base.created_at,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : base.updated_at,
    mode: ["plan", "agent", "yolo"].includes(record.mode as string) ? record.mode as string : base.mode,
    model: typeof record.model === "string" && record.model.trim() ? record.model : base.model,
    turns: Array.isArray(record.turns)
      ? record.turns.map(normalizeTurn).filter((turn): turn is Turn => !!turn)
      : [],
    messages,
    cumulative_tokens_in: numberOrZero(record.cumulative_tokens_in),
    cumulative_tokens_out: numberOrZero(record.cumulative_tokens_out),
    cumulative_cost: numberOrZero(record.cumulative_cost),
    workspace_path: typeof record.workspace_path === "string" && record.workspace_path.trim()
      ? resolve(record.workspace_path)
      : base.workspace_path,
    artifact_index: normalizeArtifactIndex(record.artifact_index),
  };

  if (!session.title || session.title === "Untitled session") {
    session.title = deriveSessionTitle(session);
  }
  return session;
}

function normalizeArtifactIndex(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) continue;
    result[key] = raw.map(String).filter(Boolean);
  }
  return result;
}

function sessionSortTime(session: Pick<Session, "updated_at">, mtimeMs = 0): number {
  const parsed = Date.parse(session.updated_at);
  return Number.isFinite(parsed) ? parsed : mtimeMs;
}

export function saveSession(session: Session): string {
  const id = safeSessionId(session.id);
  if (!id) throw new Error("Invalid session id.");
  session.id = id;
  session.updated_at = new Date().toISOString();
  refreshSessionTitle(session);

  const payload = JSON.stringify(session, null, 2);
  const errors: string[] = [];
  for (const dir of candidateSessionDirs()) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.json`), payload, "utf-8");
      return id;
    } catch (e: any) {
      errors.push(`${dir}: ${e?.message || String(e)}`);
    }
  }

  throw new Error(`Could not write session. ${errors.join(" | ")}`);
}

export function loadSession(sessionId: string): Session | null {
  const safeId = safeSessionId(sessionId);
  if (!safeId) return null;
  const matches: Array<{ session: Session; time: number }> = [];
  for (const dir of candidateSessionDirs()) {
    try {
      const filepath = join(dir, `${safeId}.json`);
      const data = JSON.parse(readFileSync(filepath, "utf-8"));
      const stat = statSync(filepath);
      const session = normalizeSession(data, safeId);
      matches.push({ session, time: sessionSortTime(session, stat.mtimeMs) });
    } catch {
      // try next candidate
    }
  }
  return matches.sort((a, b) => b.time - a.time)[0]?.session || null;
}

export function listSessions(): Array<{
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  mode: string;
  model: string;
  workspace_path: string;
  message_count: number;
}> {
  const byId = new Map<string, {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    mode: string;
    model: string;
    workspace_path: string;
    message_count: number;
  }>();
  for (const dir of candidateSessionDirs()) {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        try {
          const filepath = join(dir, f);
          const data = JSON.parse(readFileSync(filepath, "utf-8"));
          const session = normalizeSession(data, safeSessionId(f));
          const previous = byId.get(session.id);
          if (previous && sessionSortTime(previous) >= sessionSortTime(session, statSync(filepath).mtimeMs)) continue;
          byId.set(session.id, {
            id: session.id,
            title: session.title,
            created_at: session.created_at,
            updated_at: session.updated_at,
            mode: session.mode,
            model: session.model,
            workspace_path: session.workspace_path,
            message_count: session.messages.filter(message => message.role !== "system").length,
          });
        } catch {
          // skip invalid session file
        }
      }
    } catch {
      // skip unreadable candidate
    }
  }
  return [...byId.values()].sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
}

export function deleteSession(sessionId: string): boolean {
  const safeId = safeSessionId(sessionId);
  if (!safeId) return false;
  let deleted = false;
  for (const dir of candidateSessionDirs()) {
    try {
      unlinkSync(join(dir, `${safeId}.json`));
      deleted = true;
    } catch {
      // try next candidate
    }
  }
  return deleted;
}
