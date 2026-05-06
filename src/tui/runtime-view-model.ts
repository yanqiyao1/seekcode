/** Runtime-event driven TUI state for transcript, thinking, and tool status. */

import type { EngineRuntimeEvent } from "../engine/events.js";
import type { Message, Session } from "../session/types.js";
import { renderMarkdown } from "../ui/markdown.js";
import { p } from "../ui/palette.js";
import * as r from "../ui/renderer.js";
import { AssistantStream } from "./assistant-stream.js";
import { ActiveToolLines } from "./tool-lines.js";
import { Transcript } from "./transcript.js";
import { sessionMessagesToRuntimeEvents } from "./runtime-replay.js";

export type TuiTranscriptEventKind = "tool" | "thinking" | "content" | "other";

export interface TuiRuntimeViewState {
  activeStatusLine: string | null;
  activeToolCount: number;
  thinkingActive: boolean;
  thinkingStartedAt: number | null;
  lastTranscriptEvent: TuiTranscriptEventKind;
}

export type TuiStoreListener = () => void;

export class TuiStore<State> {
  private listeners = new Set<TuiStoreListener>();

  constructor(private state: State) {}

  getState(): Readonly<State> {
    return this.state;
  }

  setState(next: State | ((state: Readonly<State>) => State)): void {
    const nextState = typeof next === "function"
      ? (next as (state: Readonly<State>) => State)(this.state)
      : next;
    if (Object.is(nextState, this.state)) return;
    this.state = nextState;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: TuiStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export interface TuiRuntimeViewModelOptions {
  thinkingVisible?: boolean | (() => boolean);
  turnStartedAt?: () => number;
  renderNow?: () => void;
  requestRender?: () => void;
  now?: () => number;
  enableThinkingTimer?: boolean;
}

export interface RenderSessionTranscriptOptions {
  session: Pick<Session, "id" | "title" | "messages">;
  loaded?: boolean;
  version: string;
  model: string;
  mode: string;
  toolCount: number;
}

export class TuiRuntimeViewModel {
  readonly store = new TuiStore<TuiRuntimeViewState>({
    activeStatusLine: null,
    activeToolCount: 0,
    thinkingActive: false,
    thinkingStartedAt: null,
    lastTranscriptEvent: "other",
  });

  private readonly activeToolLines = new ActiveToolLines();
  private readonly assistantStream = new AssistantStream();
  private readonly renderedToolCalls = new Set<string>();
  private inThinking = false;
  private thinkingBuf = "";
  private thinkingStartedAt = 0;
  private thinkingRenderTimer: NodeJS.Timeout | null = null;
  private thinkingBodyFlushed = false;
  private lastTranscriptEvent: TuiTranscriptEventKind = "other";
  private replayingRuntimeEvents = false;
  private assistantContentStreamed = false;
  private thinkingStreamed = false;

  constructor(readonly transcript: Transcript, private readonly options: TuiRuntimeViewModelOptions = {}) {}

  get state(): Readonly<TuiRuntimeViewState> {
    return this.store.getState();
  }

  get activeStatusLine(): string | null {
    return this.state.activeStatusLine;
  }

  get activeToolCount(): number {
    return this.state.activeToolCount;
  }

  getSnapshot(): Readonly<TuiRuntimeViewState> {
    return this.store.getState();
  }

  subscribe(listener: TuiStoreListener): () => void {
    return this.store.subscribe(listener);
  }

  beginTurn(): void {
    this.resetRuntimeState();
  }

  finishTurn(): void {
    this.finishThinkingStatus();
    this.assistantStream.reset();
    this.activeToolLines.clear();
    this.renderedToolCalls.clear();
    this.inThinking = false;
    this.thinkingBuf = "";
    this.thinkingBodyFlushed = false;
    this.patchState({
      activeToolCount: 0,
      activeStatusLine: null,
      thinkingActive: false,
      thinkingStartedAt: null,
    });
  }

  dispose(): void {
    this.clearThinkingTimer();
  }

  renderSessionTranscript(options: RenderSessionTranscriptOptions): void {
    this.resetRuntimeState();
    this.transcript.clear();
    this.transcript.append(r.welcomeBanner(options.version, options.model, options.mode, options.toolCount));
    this.transcript.append(p.dim(options.loaded
      ? `\nLoaded session: ${options.session.title || options.session.id}. Continue typing or /help.`
      : "\nType a request or /help. Tab completes commands. Shift+Tab cycles modes."));
    if (options.loaded) this.replayRuntimeEvents(sessionMessagesToRuntimeEvents(options.session.messages));
    this.transcript.scrollToBottom();
  }

  replayRuntimeEvents(events: EngineRuntimeEvent[]): void {
    const wasReplaying = this.replayingRuntimeEvents;
    this.replayingRuntimeEvents = true;
    try {
      for (const event of events) this.handleRuntimeEvent(event);
      this.flushThinkingBody();
      this.assistantStream.reset();
      this.activeToolLines.clear();
      this.renderedToolCalls.clear();
      this.assistantContentStreamed = false;
      this.thinkingStreamed = false;
      this.syncActiveToolCount();
      this.transcript.scrollToBottom();
    } finally {
      this.replayingRuntimeEvents = wasReplaying;
    }
  }

  finishThinkingStatus(): void {
    if (!this.thinkingStartedAt) return;
    this.flushThinkingBody();
    this.clearThinkingTimer();
    this.thinkingStartedAt = 0;
    this.thinkingBodyFlushed = false;
    this.patchState({
      activeStatusLine: null,
      thinkingActive: false,
      thinkingStartedAt: null,
    });
    this.options.renderNow?.();
  }

  handleRuntimeEvent(event: EngineRuntimeEvent): void {
    switch (event.type) {
      case "api_call_start":
        this.assistantContentStreamed = false;
        this.thinkingStreamed = false;
        if (!this.isThinkingVisible()) return;
        this.ensureThinkingHeader(this.currentTurnStartedAt() || this.now());
        break;
      case "thinking_delta":
        if (!this.isThinkingVisible()) return;
        this.thinkingStreamed = true;
        if (!this.inThinking) this.separateAfterTool();
        if (!this.inThinking) {
          this.thinkingBuf = "";
          this.inThinking = true;
          this.thinkingBodyFlushed = false;
          this.ensureThinkingHeader(this.currentTurnStartedAt() || this.now());
        }
        this.thinkingBuf += event.data.text;
        this.updateThinkingHeader(false);
        break;
      case "content_delta":
        this.flushThinkingBody();
        this.assistantContentStreamed = true;
        this.assistantStream.append(this.transcript, event.data.text);
        this.setLastTranscriptEvent("content");
        this.autoFollowBottom();
        this.options.requestRender?.();
        break;
      case "user_message":
        if (this.replayingRuntimeEvents) this.renderUserMessage(event.data.text);
        break;
      case "assistant_message":
        if (this.replayingRuntimeEvents) this.renderAssistantMessage(event.data);
        break;
      case "tool_call_begin":
        this.renderToolCallStart(event.data.name, event.data.tool_call_id || event.data.name);
        break;
      case "tool_call":
        if (!this.renderedToolCalls.has(event.data.id) && !this.renderedToolCalls.has(event.data.name)) {
          this.renderToolCallStart(event.data.name, event.data.id || event.data.name);
        }
        break;
      case "tool_result":
        this.renderToolResult(event.data.name, event.preview);
        break;
      case "tool_progress":
        this.renderToolProgress(event);
        break;
      case "context_intervention":
        this.renderContextIntervention(event.data);
        break;
    }
  }

  private renderUserMessage(text: string): void {
    this.finishThinkingStatus();
    this.assistantStream.reset();
    this.activeToolLines.clear();
    this.renderedToolCalls.clear();
    this.assistantContentStreamed = false;
    this.thinkingStreamed = false;
    this.transcript.append(`\n${p.blue("›")} ${p.text(text)}`);
    this.setLastTranscriptEvent("other");
    this.autoFollowBottom();
  }

  private renderAssistantMessage(message: Message): void {
    if (message.reasoning_content && !this.thinkingStreamed) {
      this.transcript.append(r.thinkingHeader(undefined, false));
      this.transcript.append(r.thinkingText(message.reasoning_content));
      if (message.content) this.transcript.append("");
      this.setLastTranscriptEvent("thinking");
    }
    if (message.content && !this.assistantContentStreamed) {
      this.flushThinkingBody();
      this.transcript.append(renderMarkdown(message.content));
      this.setLastTranscriptEvent("content");
    }
    this.assistantStream.reset();
    this.autoFollowBottom();
  }

  private renderToolCallStart(name: string, key?: string): void {
    if (key && this.renderedToolCalls.has(key)) return;
    if (key) this.renderedToolCalls.add(key);
    this.flushThinkingBody();
    this.assistantStream.reset();
    this.transcript.append(r.toolCallStatus(name, "running"));
    this.activeToolLines.start(name, this.transcript.lines.length - 1);
    this.syncActiveToolCount();
    this.autoFollowBottom();
    this.options.renderNow?.();
  }

  private renderToolResult(name: string, preview: string): void {
    const line = r.toolCallStatus(name, preview.startsWith("Error:") ? "error" : "success", preview);
    const activeToolLine = this.activeToolLines.finish(name);
    if (activeToolLine !== undefined) this.transcript.replaceLine(activeToolLine, line);
    else this.transcript.append(line);
    const diffPreview = r.toolDiffPreview(preview);
    if (diffPreview) this.transcript.append(diffPreview);
    this.assistantStream.reset();
    this.setLastTranscriptEvent("tool");
    this.syncActiveToolCount();
    this.autoFollowBottom();
    this.options.renderNow?.();
  }

  private renderToolProgress(event: Extract<EngineRuntimeEvent, { type: "tool_progress" }>): void {
    const message = event.rendered?.preview || event.data.progress.message;
    const line = r.toolCallStatus(event.data.tool, "running", message);
    const activeToolLine = this.activeToolLines.current(event.data.tool);
    if (activeToolLine !== undefined) this.transcript.replaceLine(activeToolLine, line);
    else this.transcript.append(line);
    this.autoFollowBottom();
    this.options.requestRender?.();
  }

  private renderContextIntervention(data: unknown): void {
    const value = data as { risk?: string; action?: string; reason?: string; compaction?: { message?: string } };
    this.transcript.append(p.dim(`\nContext guard: ${value.risk || "unknown"} / ${value.action || "intervention"} — ${value.reason || "capacity intervention"}.\n`));
    if (value.compaction?.message) this.transcript.append(p.dim(value.compaction.message + "\n"));
    this.options.renderNow?.();
  }

  private resetRuntimeState(): void {
    this.clearThinkingTimer();
    this.activeToolLines.clear();
    this.assistantStream.reset();
    this.renderedToolCalls.clear();
    this.inThinking = false;
    this.thinkingBuf = "";
    this.thinkingStartedAt = 0;
    this.thinkingBodyFlushed = false;
    this.lastTranscriptEvent = "other";
    this.assistantContentStreamed = false;
    this.thinkingStreamed = false;
    this.patchState({
      activeStatusLine: null,
      activeToolCount: 0,
      thinkingActive: false,
      thinkingStartedAt: null,
      lastTranscriptEvent: "other",
    });
  }

  private ensureThinkingHeader(startedAt = this.now()): void {
    if (this.thinkingStartedAt) return;
    this.thinkingStartedAt = startedAt;
    this.setLastTranscriptEvent("thinking");
    this.patchState({
      activeStatusLine: r.thinkingStatusLine(0, true),
      thinkingActive: true,
      thinkingStartedAt: startedAt,
    });
    this.options.renderNow?.();
    this.clearThinkingTimer();
    if (this.options.enableThinkingTimer === false) return;
    this.thinkingRenderTimer = setInterval(() => {
      if (!this.thinkingStartedAt) return;
      this.updateThinkingHeader(false);
    }, 250);
    this.thinkingRenderTimer.unref?.();
  }

  private updateThinkingHeader(final = false): void {
    if (!this.thinkingStartedAt) return;
    this.patchState({
      activeStatusLine: final ? null : r.thinkingStatusLine(this.now() - this.thinkingStartedAt, true),
    });
    if (final) this.options.renderNow?.();
    else this.options.requestRender?.();
  }

  private flushThinkingBody(): void {
    if (this.thinkingBodyFlushed) return;
    const formatted = r.thinkingText(this.thinkingBuf);
    if (formatted) {
      this.transcript.append(formatted);
      this.transcript.append("");
      this.transcript.append("");
      this.setLastTranscriptEvent("thinking");
    }
    this.thinkingBodyFlushed = true;
    this.inThinking = false;
    this.thinkingBuf = "";
    this.assistantStream.reset();
  }

  private separateAfterTool(): void {
    if (this.lastTranscriptEvent !== "tool") return;
    if (!this.transcript.lines.length) return;
    if (!this.transcript.lines.at(-1)?.text.trim()) return;
    this.transcript.append("");
    this.setLastTranscriptEvent("other");
  }

  private syncActiveToolCount(): void {
    this.patchState({ activeToolCount: this.activeToolLines.size });
  }

  private setLastTranscriptEvent(kind: TuiTranscriptEventKind): void {
    this.lastTranscriptEvent = kind;
    this.patchState({ lastTranscriptEvent: kind });
  }

  private autoFollowBottom(): void {
    if (this.transcript.scrollOffset === 0) this.transcript.scrollToBottom();
  }

  private clearThinkingTimer(): void {
    if (!this.thinkingRenderTimer) return;
    clearInterval(this.thinkingRenderTimer);
    this.thinkingRenderTimer = null;
  }

  private isThinkingVisible(): boolean {
    const visible = this.options.thinkingVisible;
    return typeof visible === "function" ? visible() : visible !== false;
  }

  private currentTurnStartedAt(): number {
    return this.options.turnStartedAt?.() ?? 0;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private patchState(patch: Partial<TuiRuntimeViewState>): void {
    const previous = this.store.getState();
    let changed = false;
    for (const key of Object.keys(patch) as (keyof TuiRuntimeViewState)[]) {
      if (previous[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.store.setState({ ...previous, ...patch });
  }
}
