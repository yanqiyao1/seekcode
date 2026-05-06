/** Convert persisted runtime/session records into replayable EngineRuntimeEvent streams. */

import type { EngineRuntimeEvent, ToolProgressRuntimeEvent, ToolResultRuntimeEvent } from "../engine/events.js";
import type { ContextIntervention } from "../engine/context-manager.js";
import type { Message, ToolCall, ToolResult } from "../session/types.js";

export interface RuntimeItemLike {
  type: string;
  data: unknown;
  artifact_ids?: string[];
}

export function sessionMessagesToRuntimeEvents(
  messages: Message[],
  options: { maxMessages?: number } = {},
): EngineRuntimeEvent[] {
  const maxMessages = options.maxMessages ?? 80;
  const replayMessages = messages.filter(message => message.role !== "system").slice(-maxMessages);
  const events: EngineRuntimeEvent[] = [];

  for (const message of replayMessages) {
    if (message.role === "user") {
      events.push({ type: "user_message", data: { text: message.content || "" } });
      continue;
    }

    if (message.role === "assistant") {
      events.push({ type: "assistant_message", data: message });
      for (const toolCall of message.tool_calls || []) {
        events.push({ type: "tool_call", data: toolCall });
      }
      continue;
    }

    if (message.role === "tool") {
      const content = message.content || "";
      const result: ToolResult = {
        tool_call_id: message.tool_call_id || message.name || "tool",
        name: message.name || "tool",
        content,
        is_error: message.is_error ?? /^Error:|was denied\./i.test(content),
      };
      events.push({ type: "tool_result", data: result, preview: content });
    }
  }

  return events;
}

export function runtimeItemsToEngineRuntimeEvents(items: RuntimeItemLike[]): EngineRuntimeEvent[] {
  return items
    .map(runtimeItemToEngineRuntimeEvent)
    .filter((event): event is EngineRuntimeEvent => !!event);
}

export function runtimeItemToEngineRuntimeEvent(item: RuntimeItemLike): EngineRuntimeEvent | null {
  const data = item.data as Record<string, unknown>;
  switch (item.type) {
    case "api_call_start":
      return { type: "api_call_start", data: {} };
    case "thinking_delta":
      return { type: "thinking_delta", data: { text: String(data?.text ?? "") } };
    case "content_delta":
      return { type: "content_delta", data: { text: String(data?.text ?? "") } };
    case "user_message":
      return { type: "user_message", data: { text: String(data?.text ?? "") } };
    case "assistant_message":
      return { type: "assistant_message", data: data as unknown as Message };
    case "tool_call_begin":
      return {
        type: "tool_call_begin",
        data: {
          name: String(data?.name ?? "tool"),
          tool_call_id: typeof data?.tool_call_id === "string" ? data.tool_call_id : undefined,
          index: typeof data?.index === "number" ? data.index : undefined,
        },
        artifact_ids: item.artifact_ids,
      };
    case "tool_call":
      return { type: "tool_call", data: data as unknown as ToolCall, artifact_ids: item.artifact_ids };
    case "tool_result": {
      const result = data as unknown as ToolResult;
      return {
        type: "tool_result",
        data: result,
        artifact_ids: item.artifact_ids,
        preview: typeof data?.content === "string" ? data.content : "",
      } satisfies ToolResultRuntimeEvent;
    }
    case "tool_progress":
      return {
        type: "tool_progress",
        data: data as ToolProgressRuntimeEvent["data"],
        artifact_ids: item.artifact_ids,
      };
    case "context_intervention":
      return { type: "context_intervention", data: data as unknown as ContextIntervention, artifact_ids: item.artifact_ids };
    default:
      return null;
  }
}
