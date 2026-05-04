/** Context compaction for 1M-token context management. */

import type { Config } from "../config.js";
import type { Message } from "../session/types.js";
import type { ConversationHistory } from "../session/history.js";

export interface CompactionResult {
  actions: string[];
  finalTokens: number;
  message: string;
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
      this.summarizeOld,
      this.dropToolResults,
      this.dropReasoning,
      this.keepLastN,
    ];

    const result: CompactionResult = { actions: [], finalTokens: 0, message: "" };

    for (const strategy of strategies) {
      const tokenCount = history.approximateTokenCount();
      if (tokenCount < this.config.context_limit * 0.7) {
        result.finalTokens = tokenCount;
        result.message = result.message || "Compaction not needed.";
        break;
      }

      const before = tokenCount;
      strategy.call(this, messages);
      const after = history.approximateTokenCount();
      result.actions.push(
        `${strategy.name.replace("bound ", "")}: ${before.toLocaleString()} → ${after.toLocaleString()} tokens`,
      );
    }

    result.finalTokens = history.approximateTokenCount();
    result.message = `Context compacted (${this.compactionCount}x):\n${result.actions.join("\n")}`;
    return result;
  }

  private summarizeOld(messages: Message[]): void {
    if (messages.length < 10) return;
    const cutoff = Math.max(1, Math.floor(messages.length / 4));
    const systemMsgs = messages.filter(m => m.role === "system");
    const others = messages.filter(m => m.role !== "system");
    const removed = others.splice(0, cutoff);
    messages.length = 0;
    messages.push(...systemMsgs);
    messages.push({
      role: "user", content: `[Earlier conversation summarized — ${removed.length} messages omitted]`,
      tool_calls: null, tool_call_id: null, name: null, reasoning_content: null,
    });
    messages.push(...others);
  }

  private dropToolResults(messages: Message[]): void {
    const half = Math.floor(messages.length * 0.5);
    messages.forEach((msg, i) => {
      if (msg.role === "tool" && i < half && (msg.content?.length || 0) > 500) {
        msg.content = "[Tool result truncated for context]";
      }
    });
  }

  private dropReasoning(messages: Message[]): void {
    const cutoff = Math.floor(messages.length * 0.6);
    messages.forEach((msg, i) => {
      if (msg.role === "assistant" && msg.reasoning_content && i < cutoff) {
        msg.reasoning_content = null;
      }
    });
  }

  private keepLastN(messages: Message[], n = 20): void {
    const systemMsgs = messages.filter(m => m.role === "system");
    const others = messages.filter(m => m.role !== "system");
    const kept = others.slice(-n);
    messages.length = 0;
    messages.push(...systemMsgs);
    messages.push(...kept);
  }
}
