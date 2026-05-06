/** Conversation history manager. */

import type { Message, Session, ToolCall, ToolResult } from "./types.js";
import { createSession } from "./types.js";
import { estimateMessagesTokens } from "../engine/compact.js";

export class ConversationHistory {
  session: Session;

  constructor(session?: Session) {
    this.session = session || createSession();
  }

  addSystem(content: string): void {
    this.session.messages.push({ role: "system", content, tool_calls: null, tool_call_id: null, name: null, reasoning_content: null });
  }

  addUser(content: string): void {
    this.session.messages.push({ role: "user", content, tool_calls: null, tool_call_id: null, name: null, reasoning_content: null });
  }

  addAssistant(
    content?: string | null,
    toolCalls?: ToolCall[] | null,
    reasoningContent?: string | null,
  ): Message {
    const msg: Message = {
      role: "assistant",
      content: content || "",
      tool_calls: (toolCalls && toolCalls.length > 0) ? toolCalls : null,
      tool_call_id: null,
      name: null,
      reasoning_content: reasoningContent || null,
    };
    this.session.messages.push(msg);
    return msg;
  }

  addToolResult(result: ToolResult): void {
    this.session.messages.push({
      role: "tool",
      content: result.content,
      tool_calls: null,
      tool_call_id: result.tool_call_id,
      name: result.name,
      reasoning_content: null,
      is_error: result.is_error,
    });
  }

  getMessages(): Message[] {
    return [...this.session.messages];
  }

  approximateTokenCount(): number {
    return estimateMessagesTokens(this.session.messages);
  }

  clear(): void {
    this.session.messages = [];
  }
}
