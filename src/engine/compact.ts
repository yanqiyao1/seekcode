/** Context compaction for 1M-token context management. */

import type { Config } from "../config.js";
import type { Message } from "../session/types.js";
import type { ConversationHistory } from "../session/history.js";

export interface CompactionResult {
  actions: string[];
  finalTokens: number;
  message: string;
  boundary_id?: string;
  removed_messages?: number;
  original_tokens?: number;
}

interface CompactionState {
  boundaryId: string;
  compactionIndex: number;
  originalTokens: number;
  originalMessages: number;
  removedMessages: number;
  truncatedToolResults: number;
  droppedReasoning: number;
}

interface StrategyOutcome {
  changed: boolean;
  detail: string;
}

export class ContextCompactor {
  private config: Config;
  private compactionCount = 0;

  constructor(config: Config) {
    this.config = config;
  }

  shouldCompact(history: ConversationHistory): boolean {
    return history.approximateTokenCount() > this.config.context_limit;
  }

  compact(history: ConversationHistory): CompactionResult {
    this.compactionCount++;
    const messages = history.session.messages;
    const strategies = [
      { name: "summarizeOld", run: this.summarizeOld.bind(this) },
      { name: "dropToolResults", run: this.dropToolResults.bind(this) },
      { name: "dropReasoning", run: this.dropReasoning.bind(this) },
      { name: "keepLastN", run: this.keepLastN.bind(this) },
    ];
    const state: CompactionState = {
      boundaryId: `compact_${Date.now().toString(36)}_${this.compactionCount}`,
      compactionIndex: this.compactionCount,
      originalTokens: history.approximateTokenCount(),
      originalMessages: messages.length,
      removedMessages: 0,
      truncatedToolResults: 0,
      droppedReasoning: 0,
    };

    const result: CompactionResult = {
      actions: [],
      finalTokens: 0,
      message: "",
      original_tokens: state.originalTokens,
      removed_messages: 0,
    };

    for (const strategy of strategies) {
      const tokenCount = history.approximateTokenCount();
      if (tokenCount < this.config.context_limit * 0.7) {
        result.finalTokens = tokenCount;
        result.message = result.message || "Compaction not needed.";
        break;
      }

      const before = tokenCount;
      const outcome = strategy.run(messages, state);
      const after = history.approximateTokenCount();
      if (outcome.changed || before !== after) {
        const detail = outcome.detail ? ` (${outcome.detail})` : "";
        result.actions.push(`${strategy.name}: ${before.toLocaleString()} -> ${after.toLocaleString()} tokens${detail}`);
      }
    }

    if (result.actions.length) {
      insertBoundaryMessage(messages, buildBoundaryMessage(state, result.actions, history.approximateTokenCount()));
      result.boundary_id = state.boundaryId;
    }
    result.finalTokens = history.approximateTokenCount();
    result.removed_messages = state.removedMessages;
    result.message = result.actions.length
      ? `Context compacted (${this.compactionCount}x, boundary ${state.boundaryId}):\n${result.actions.join("\n")}`
      : "Compaction attempted, but no compactable content was found.";
    return result;
  }

  private summarizeOld(messages: Message[], state: CompactionState): StrategyOutcome {
    if (messages.length < 10) return { changed: false, detail: "" };
    const cutoff = Math.max(1, Math.floor(messages.length / 4));
    const systemMsgs = messages.filter(m => m.role === "system");
    const others = messages.filter(m => m.role !== "system");
    const removed = others.splice(0, cutoff);
    if (!removed.length) return { changed: false, detail: "" };
    messages.length = 0;
    messages.push(...systemMsgs);
    messages.push(...others);
    state.removedMessages += removed.length;
    return { changed: true, detail: `${removed.length} old messages omitted` };
  }

  private dropToolResults(messages: Message[], state: CompactionState): StrategyOutcome {
    const half = Math.floor(messages.length * 0.5);
    let count = 0;
    messages.forEach((msg, i) => {
      if (msg.role === "tool" && i < half && (msg.content?.length || 0) > 500) {
        msg.content = "[Tool result truncated for context]";
        count++;
      }
    });
    state.truncatedToolResults += count;
    return { changed: count > 0, detail: count ? `${count} old tool results truncated` : "" };
  }

  private dropReasoning(messages: Message[], state: CompactionState): StrategyOutcome {
    const cutoff = Math.floor(messages.length * 0.6);
    let count = 0;
    messages.forEach((msg, i) => {
      if (msg.role === "assistant" && msg.reasoning_content && i < cutoff) {
        msg.reasoning_content = null;
        count++;
      }
    });
    state.droppedReasoning += count;
    return { changed: count > 0, detail: count ? `${count} reasoning blocks dropped` : "" };
  }

  private keepLastN(messages: Message[], state: CompactionState, n = 20): StrategyOutcome {
    const systemMsgs = messages.filter(m => m.role === "system");
    const others = messages.filter(m => m.role !== "system");
    if (others.length <= n) return { changed: false, detail: "" };
    const kept = others.slice(-n);
    const removed = others.length - kept.length;
    messages.length = 0;
    messages.push(...systemMsgs);
    messages.push(...kept);
    state.removedMessages += removed;
    return { changed: true, detail: `${removed} messages dropped; kept last ${n}` };
  }
}

function buildBoundaryMessage(state: CompactionState, actions: string[], finalTokensBeforeBoundary: number): Message {
  return {
    role: "system",
    content: [
      "[Context compaction boundary]",
      `boundary_id: ${state.boundaryId}`,
      `compaction_index: ${state.compactionIndex}`,
      `original_tokens: ${state.originalTokens}`,
      `tokens_before_boundary: ${finalTokensBeforeBoundary}`,
      `original_messages: ${state.originalMessages}`,
      `removed_messages: ${state.removedMessages}`,
      `truncated_tool_results: ${state.truncatedToolResults}`,
      `dropped_reasoning_blocks: ${state.droppedReasoning}`,
      "reason: context pressure required reducing older conversation state before the next model call.",
      "recovery: treat omitted details as unknown; verify with tools, artifacts, or saved transcript records before relying on them.",
      "actions:",
      ...actions.map(action => `- ${action}`),
    ].join("\n"),
    tool_calls: null,
    tool_call_id: null,
    name: "context_compaction_boundary",
    reasoning_content: null,
  };
}

function insertBoundaryMessage(messages: Message[], boundary: Message): void {
  const firstNonSystem = messages.findIndex(message => message.role !== "system");
  if (firstNonSystem < 0) {
    messages.push(boundary);
    return;
  }
  messages.splice(firstNonSystem, 0, boundary);
}
