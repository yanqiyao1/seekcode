/** DeepSeek API client wrapping the OpenAI SDK. */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { StreamEvent, ContentDelta, ThinkingDelta, ToolCallBegin, ToolCallArgsDelta, StreamDone, SendOptions, UsageTelemetry } from "./base.js";
import type { Message, ToolCall } from "../session/types.js";
import { messageToApiDict } from "../session/types.js";
import {
  applyReasoningEffort,
  parseProvider,
  providerCapability,
  shouldReplayReasoningContent,
  type ApiProvider,
  type ProviderCapability,
} from "./capabilities.js";

interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: string;
}

export class DeepSeekClient {
  private client: OpenAI;
  private model: string;
  private provider: ApiProvider;
  readonly capability: ProviderCapability;

  constructor(opts: ClientOptions) {
    this.provider = parseProvider(opts.provider);
    this.capability = providerCapability(this.provider, opts.model);
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
    });
    this.model = this.capability.resolved_model;
  }

  async *send(
    messages: Message[],
    tools?: Record<string, unknown>[] | null,
    options: SendOptions = {},
  ): AsyncIterable<StreamEvent> {
    throwIfAborted(options.signal);
    const apiMessages = sanitizeMessagesForThinkingMode(
      messages.map(messageToApiDict),
      this.model,
      options.reasoning_effort,
    ) as unknown as ChatCompletionMessageParam[];

    const effectiveMaxTokens = Math.min(normalizeMaxTokens(options.max_tokens), this.capability.max_output);

    const request: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
      stream: true,
      max_tokens: effectiveMaxTokens,
      stream_options: { include_usage: true },
    };
    if (tools?.length) {
      request.tools = tools as any;
    }
    applyReasoningEffort(request, options.reasoning_effort, this.provider, this.capability.thinking_supported);

    const stream = options.signal
      ? await this.client.chat.completions.create(request as any, { signal: options.signal } as any) as any
      : await this.client.chat.completions.create(request as any) as any;

    let accumulatedContent = "";
    let accumulatedReasoning = "";
    const toolCallsAcc: Map<number, { id: string; name: string; arguments: string; began: boolean }> = new Map();
    let finishReason = "stop";
    let streamUsage: UsageTelemetry | null = null;

    for await (const chunk of stream) {
      throwIfAborted(options.signal);
      const delta = (chunk.choices?.[0] as any)?.delta;
      const chunkUsage = (chunk as any).usage;
      if (chunkUsage) {
        streamUsage = chunkUsage as UsageTelemetry;
      }
      if (!delta) continue;

      // Content
      if (delta.content) {
        accumulatedContent += delta.content;
        yield { type: "content", text: delta.content } as ContentDelta;
      }

      // Reasoning (DeepSeek-specific, in model_extra or directly)
      const reasoning = delta.reasoning_content || (delta as any).reasoning_content || "";
      if (reasoning) {
        accumulatedReasoning += reasoning;
        yield { type: "thinking", text: reasoning } as ThinkingDelta;
      }

      // Tool calls
      const tcDeltas = (delta.tool_calls || []) as any[];
      for (const tc of tcDeltas) {
        const idx = tc.index ?? 0;
        if (!toolCallsAcc.has(idx)) {
          toolCallsAcc.set(idx, { id: "", name: "", arguments: "", began: false });
        }
        const acc = toolCallsAcc.get(idx)!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) {
          acc.name = tc.function.name;
          if (!acc.began) {
            acc.began = true;
            yield { type: "tool_call_begin", index: idx, tool_call_id: acc.id, name: acc.name } as ToolCallBegin;
          }
        }
        if (tc.function?.arguments) {
          acc.arguments += tc.function.arguments;
          yield {
            type: "tool_call_args",
            index: idx,
            tool_call_id: acc.id,
            name: acc.name,
            arguments: tc.function.arguments,
          } as ToolCallArgsDelta;
        }
      }

      const fin = (chunk.choices?.[0] as any)?.finish_reason;
      if (fin) finishReason = fin;

    }
    throwIfAborted(options.signal);

    // Assemble final tool calls
    const toolCalls: ToolCall[] = [];
    for (const [, tc] of [...toolCallsAcc.entries()].sort(([a], [b]) => a - b)) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments || "{}"); } catch { /* empty */ }
      toolCalls.push({ id: tc.id, name: tc.name, arguments: args });
    }

    yield {
      type: "done",
      finish_reason: finishReason,
      usage: streamUsage,
      content: accumulatedContent,
      reasoning_content: accumulatedReasoning || null,
      tool_calls: toolCalls,
    } as StreamDone;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async countTokens(messages: Message[]): Promise<number> {
    try {
      const tiktoken = await import("tiktoken");
      const enc = tiktoken.get_encoding("cl100k_base");
      let total = 0;
      for (const m of messages) {
        total += 4; // framing overhead
        let text = m.content || "";
        if (m.reasoning_content) text += m.reasoning_content;
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            text += tc.name + JSON.stringify(tc.arguments);
          }
        }
        total += enc.encode(text).length;
      }
      return total;
    } catch {
      return this.estimateTokens(messages.map(m => m.content || "").join(" "));
    }
  }
}

function normalizeMaxTokens(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 8192;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Request aborted", "AbortError");
}

export function sanitizeMessagesForThinkingMode(
  messages: Record<string, unknown>[],
  model: string,
  effort?: string | null,
): Record<string, unknown>[] {
  if (!shouldReplayReasoningContent(model, effort)) {
    return messages.map(message => stripReasoningContent({ ...message }));
  }

  const sanitized = messages.map(message => ({ ...message }));
  for (const message of sanitized) {
    if (message.role !== "assistant") continue;
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    if (!reasoning) message.reasoning_content = "(reasoning omitted)";
    if (message.content === undefined || message.content === null) {
      message.content = "";
    }
  }
  return sanitized;
}

function stripEmptyReasoningContent(message: Record<string, unknown>): Record<string, unknown> {
  const reasoning = message.reasoning_content;
  if (typeof reasoning !== "string" || !reasoning.trim()) delete message.reasoning_content;
  return message;
}

function stripReasoningContent(message: Record<string, unknown>): Record<string, unknown> {
  delete message.reasoning_content;
  return message;
}
