/** Abstract client interface and stream event types. */

import type { Message, ToolCall } from "../session/types.js";

export type UsageTelemetry = Record<string, unknown>;

export interface StreamEvent {
  type: "content" | "thinking" | "tool_call_begin" | "tool_call_args" | "done";
}

export interface ContentDelta extends StreamEvent {
  type: "content";
  text: string;
}

export interface ThinkingDelta extends StreamEvent {
  type: "thinking";
  text: string;
}

export interface ToolCallBegin extends StreamEvent {
  type: "tool_call_begin";
  index: number;
  tool_call_id: string;
  name: string;
}

export interface ToolCallArgsDelta extends StreamEvent {
  type: "tool_call_args";
  index: number;
  tool_call_id: string;
  name: string;
  arguments: string;
}

export interface StreamDone extends StreamEvent {
  type: "done";
  finish_reason: string;
  usage: UsageTelemetry | null;
  content: string;
  reasoning_content: string | null;
  tool_calls: ToolCall[];
}

export interface ModelResponse {
  content: string;
  reasoning_content: string | null;
  tool_calls: ToolCall[];
  usage: UsageTelemetry | null;
  finish_reason: string;
}

export interface SendOptions {
  stream?: boolean;
  reasoning_effort?: string;
  max_tokens?: number;
  signal?: AbortSignal;
}

export interface BaseClient {
  send(
    messages: Message[],
    tools?: Record<string, unknown>[] | null,
    options?: SendOptions,
  ): AsyncIterable<StreamEvent>;

  estimateTokens(text: string): number;
  countTokens(messages: Message[]): Promise<number>;
}
