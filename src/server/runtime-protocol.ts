import type { EngineRuntimeEvent } from "../engine/events.js";
import type { RuntimeEvent } from "./runtime-store.js";

export interface RuntimeSSEMessage {
  event: string;
  data: unknown;
}

export interface RuntimeSSEFrameLike {
  event?: string;
  id?: string;
  data?: string;
}

export function isSpeculativeRuntimeEvent(event: EngineRuntimeEvent): boolean {
  return event.type === "api_call_start"
    || event.type === "thinking_delta"
    || event.type === "content_delta"
    || event.type === "tool_call_begin";
}

export function runtimeEventToSSE(
  event: EngineRuntimeEvent,
  streamedToolCalls: Set<string>,
): RuntimeSSEMessage | null {
  switch (event.type) {
    case "thinking_delta":
      return { event: "thinking", data: event.data };
    case "content_delta":
      return { event: "content", data: event.data };
    case "tool_call_begin": {
      const key = event.data.tool_call_id || event.data.name;
      streamedToolCalls.add(key);
      return { event: "tool_call", data: { name: event.data.name, tool_call_id: event.data.tool_call_id } };
    }
    case "tool_call": {
      if (streamedToolCalls.has(event.data.id) || streamedToolCalls.has(event.data.name)) return null;
      streamedToolCalls.add(event.data.id || event.data.name);
      return { event: "tool_call", data: { name: event.data.name, tool_call_id: event.data.id } };
    }
    case "tool_result":
      return { event: "tool_result", data: { name: event.data.name, preview: event.preview, artifact_ids: event.artifact_ids || [] } };
    case "tool_progress":
      return { event: "tool_progress", data: event.data };
    case "context_intervention":
      return { event: "context_intervention", data: event.data };
    case "prefix_invalidated":
      return { event: "prefix_invalidated", data: event.data };
    default:
      return null;
  }
}

export function parseRuntimeSSEFrame(frame: RuntimeSSEFrameLike): RuntimeEvent | null {
  if (!frame.data) return null;
  const parsed = parseJson(frame.data);
  if (!isRecord(parsed)) return null;
  if (typeof parsed.seq === "number" && typeof parsed.event === "string" && "data" in parsed) {
    return {
      seq: parsed.seq,
      thread_id: typeof parsed.thread_id === "string" ? parsed.thread_id : "",
      turn_id: typeof parsed.turn_id === "string" ? parsed.turn_id : undefined,
      event: parsed.event,
      data: parsed.data,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
    };
  }
  return {
    seq: Number.isFinite(Number(frame.id)) ? Number(frame.id) : 0,
    thread_id: "",
    event: frame.event || "message",
    data: parsed,
    created_at: "",
  };
}

export function parseRuntimeSSEMessage(frame: RuntimeSSEFrameLike): RuntimeSSEMessage | null {
  if (!frame.event || !frame.data) return null;
  return { event: frame.event, data: parseJson(frame.data) };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
