/** Stable runtime events emitted by the query engine. */

import type { Message, ToolCall, ToolResult } from "../session/types.js";
import type { ToolProgress, ToolRenderedResult } from "../tools/base.js";
import type { ToolStats } from "../tools/registry.js";
import type { ContextIntervention } from "./context-manager.js";
import type { PrefixMetadata } from "./prefix.js";

export interface ApprovalAuditEventData {
  tool: string;
  decision: "allow" | "deny";
  reason?: string;
}

export interface HookEventData {
  event: "PreToolUse" | "PostToolUse";
  tool: string;
  decision?: string;
  message?: string;
  modified_input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PrefixInvalidatedEventData {
  reason: string;
  boundary_id?: string;
  compaction?: {
    actions: string[];
    finalTokens: number;
    original_tokens?: number;
    removed_messages?: number;
    preserved_messages?: number;
    summary_message_name?: string;
  };
}

export interface ToolResultRuntimeEvent extends EngineRuntimeEventBase<"tool_result", ToolResult> {
  preview: string;
  rendered?: ToolRenderedResult;
}

export interface ToolProgressRuntimeEvent extends EngineRuntimeEventBase<"tool_progress", {
  tool: string;
  tool_call_id: string;
  progress: ToolProgress;
}> {
  rendered?: ToolRenderedResult;
}

export interface EngineRuntimeEventMap {
  api_call_start: { prefix_hash?: string; tool_schema_count?: number };
  prefix_pinned: PrefixMetadata;
  prefix_invalidated: PrefixInvalidatedEventData;
  thinking_delta: { text: string };
  content_delta: { text: string };
  tool_call_begin: { name: string; tool_call_id?: string; index?: number };
  user_message: { text: string };
  assistant_message: Message;
  tool_catalog_auto_activate: { tools: string[]; source: "user_input" };
  context_intervention: ContextIntervention;
  tool_call: ToolCall;
  tool_budget_exceeded: { tool: string; budget: number };
  approval_audit: ApprovalAuditEventData;
  hook: HookEventData;
  tool_stats: { stats: ToolStats; degraded: string | null };
}

export interface EngineRuntimeEventBase<Type extends string, Data> {
  type: Type;
  data: Data;
  artifact_ids?: string[];
}

export type EngineRuntimeEvent =
  | {
      [Type in keyof EngineRuntimeEventMap]: EngineRuntimeEventBase<Type, EngineRuntimeEventMap[Type]>
    }[keyof EngineRuntimeEventMap]
  | ToolResultRuntimeEvent
  | ToolProgressRuntimeEvent;

export interface RuntimeEventCallbacks {
  onRuntimeEvent?(event: EngineRuntimeEvent): void | Promise<void>;
  onRuntimeItem?(item: EngineRuntimeEvent): void | Promise<void>;
  onThinking?(text: string): void | Promise<void>;
  onContent?(text: string): void | Promise<void>;
  onToolCallStart?(name: string): void | Promise<void>;
  onToolExecuted?(name: string, preview: string): void | Promise<void>;
  onApiCallStart?(): void | Promise<void>;
  onContextIntervention?(intervention: unknown): void | Promise<void>;
}

export async function emitRuntimeEvent(
  callbacks: RuntimeEventCallbacks | undefined,
  event: EngineRuntimeEvent,
): Promise<void> {
  await callbacks?.onRuntimeEvent?.(event);
  await callbacks?.onRuntimeItem?.(event);
  await emitLegacyUICallback(callbacks, event);
}

async function emitLegacyUICallback(
  callbacks: RuntimeEventCallbacks | undefined,
  event: EngineRuntimeEvent,
): Promise<void> {
  switch (event.type) {
    case "api_call_start":
      await callbacks?.onApiCallStart?.();
      break;
    case "thinking_delta":
      await callbacks?.onThinking?.(event.data.text);
      break;
    case "content_delta":
      await callbacks?.onContent?.(event.data.text);
      break;
    case "tool_call_begin":
      await callbacks?.onToolCallStart?.(event.data.name);
      break;
    case "tool_result":
      await callbacks?.onToolExecuted?.(event.data.name, event.preview);
      break;
    case "context_intervention":
      await callbacks?.onContextIntervention?.(event.data);
      break;
  }
}
