import { describe, expect, it, vi } from "vitest";

import { nextModeName } from "../src/modes/base.js";
import { fitAnsi, stripAnsi, truncateAnsi, visibleLength, wrapAnsi } from "../src/ui/ansi.js";
import {
  COMMANDS,
  coalesceInputSequences,
  commandCompletionProvider,
  disableBracketedPaste,
  enableBracketedPaste,
  InputController,
  isBracketedPasteEnd,
  isBracketedPasteStart,
  isPlainTextInputSequence,
  isShiftTabSequence,
  nextGraphemeIndex,
  previousGraphemeIndex,
  restoreTTYInput,
  scrollActionForSequence,
  shouldTreatNewlineAsPaste,
  splitInputSequences,
  trailingIncompleteEscapeStart,
} from "../src/ui/input.js";
import { renderMarkdown } from "../src/ui/markdown.js";
import { movePickerIndex, pickerActionForSequence, pickerWindow } from "../src/ui/picker.js";
import { footerDivider, statusBar, statusBarFromItems, thinkingHeader, thinkingStatusLine, thinkingText, toolDiffPreview, welcomeBanner } from "../src/ui/renderer.js";
import { AssistantStream } from "../src/tui/assistant-stream.js";
import { shouldUseAlternateScreen } from "../src/tui/alternate-screen.js";
import { FrameRenderer, shouldUseSynchronizedOutput } from "../src/tui/frame-renderer.js";
import { TuiLayout } from "../src/tui/layout.js";
import { denyModeSwitchWhileRunning, RUNNING_MODE_SWITCH_BLOCKED_MESSAGE } from "../src/tui/live-mode-guard.js";
import { approvalModalLines, pickerModalLines } from "../src/tui/modal.js";
import { runtimeItemsToEngineRuntimeEvents, sessionMessagesToRuntimeEvents } from "../src/tui/runtime-replay.js";
import { TuiRuntimeViewModel } from "../src/tui/runtime-view-model.js";
import { ActiveToolLines } from "../src/tui/tool-lines.js";
import { Transcript } from "../src/tui/transcript.js";
import { createSession } from "../src/session/types.js";

describe("ANSI helpers", () => {
  it("measures wide characters without counting ANSI codes", () => {
    expect(visibleLength("\x1b[31m你\x1b[0m好🙂")).toBe(6);
  });

  it("fits and truncates colored text to terminal width", () => {
    expect(visibleLength(fitAnsi("\x1b[31mhello\x1b[0m", 8))).toBe(8);
    expect(visibleLength(truncateAnsi("\x1b[31mhello world\x1b[0m", 5))).toBe(5);
  });

  it("wraps wide text by display width", () => {
    expect(wrapAnsi("你好abc", 4).map(visibleLength)).toEqual([4, 3]);
  });

  it("preserves active SGR color across wrapped rows", () => {
    const wrapped = wrapAnsi("\x1b[31mabcdef\x1b[39m", 3);

    expect(wrapped).toHaveLength(2);
    expect(wrapped[1].startsWith("\x1b[31m")).toBe(true);
    expect(wrapped.map(stripAnsi)).toEqual(["abc", "def"]);
  });
});

describe("Transcript", () => {
  it("appends streaming deltas onto the current line", () => {
    const transcript = new Transcript();
    transcript.appendDelta("hello");
    transcript.appendDelta(" world\nnext");

    expect(transcript.lines.map(line => line.text)).toEqual(["hello world", "next"]);
  });

  it("clears transcript content and scroll state", () => {
    const transcript = new Transcript();
    transcript.append("hello\nworld");
    transcript.render(1, 10);
    transcript.scrollUp(1);

    transcript.clear();

    expect(transcript.lines).toEqual([]);
    expect(transcript.scrollOffset).toBe(0);
    expect(transcript.desiredHeight(10)).toBe(0);
  });

  it("renders short transcript from the top", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    const rendered = transcript.render(2, 3).split("\n");
    expect(rendered).toHaveLength(2);
    expect(stripAnsi(rendered[0])).toBe("abc");
    expect(rendered.every(line => visibleLength(line) === 3)).toBe(true);
  });

  it("renders empty transcripts as padded blank rows", () => {
    const transcript = new Transcript();
    expect(transcript.render(2, 4).split("\n")).toEqual(["    ", "    "]);
  });

  it("reports wrapped content height", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    expect(transcript.desiredHeight(3)).toBe(2);
  });

  it("scrolls through wrapped transcript content", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"));

    expect(stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim())).toEqual([
      "line 7",
      "line 8",
      "line 9",
    ]);

    transcript.scrollUp(2);
    expect(stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim())).toEqual([
      "line 5",
      "line 6",
      "line 7",
    ]);

    transcript.scrollToTop();
    expect(stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim())).toEqual([
      "line 0",
      "line 1",
      "line 2",
    ]);

    transcript.scrollToBottom();
    expect(transcript.scrollOffset).toBe(0);
  });

  it("caps scroll offset by wrapped render height", () => {
    const transcript = new Transcript();
    transcript.append("abcdefghij");
    transcript.render(2, 3);

    transcript.scrollUp(100);
    transcript.render(2, 3);

    expect(transcript.scrollOffset).toBe(2);
  });

  it("keeps the visible history anchored while new transcript content arrives", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"));
    transcript.render(3, 80);
    transcript.scrollUp(2);
    const before = stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim());

    transcript.append("line 8\nline 9");
    const after = stripAnsi(transcript.render(3, 80)).split("\n").map(line => line.trim());

    expect(before).toEqual(["line 3", "line 4", "line 5"]);
    expect(after).toEqual(before);
    expect(transcript.scrollOffset).toBe(4);
  });

  it("retains more than ten thousand transcript lines", () => {
    const transcript = new Transcript();
    transcript.maxLines = 20_000;
    transcript.append(Array.from({ length: 12_000 }, (_, index) => `line ${index}`).join("\n"));

    expect(transcript.lines).toHaveLength(12_000);
    expect(transcript.lines[0].text).toBe("line 0");
    expect(transcript.lines.at(-1)?.text).toBe("line 11999");
  });

  it("returns wrapped row ranges that match full wrapping slices", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 60 }, (_, index) => `row-${index}-abcdef`).join("\n"));

    const full = transcript.wrappedRows(5).map(stripAnsi);
    expect(transcript.wrappedRowsRange(5, 10, 18).map(stripAnsi)).toEqual(full.slice(10, 18));
    expect(transcript.wrappedRowsRange(5, full.length - 8, full.length - 2).map(stripAnsi)).toEqual(full.slice(-8, -2));
  });

  it("invalidates cached wrap heights when transcript lines change", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    expect(transcript.desiredHeight(3)).toBe(2);
    transcript.replaceLine(0, "xy");
    expect(transcript.desiredHeight(3)).toBe(1);
    expect(stripAnsi(transcript.render(2, 3)).split("\n").map(line => line.trim())).toEqual(["xy", ""]);

    transcript.appendDelta("z1");
    expect(transcript.desiredHeight(3)).toBe(2);
    transcript.replaceRange(0, 1, "a\nbcdef");
    expect(transcript.desiredHeight(3)).toBe(3);
  });

  it("drops cached wrap heights when old transcript lines are trimmed", () => {
    const transcript = new Transcript();
    transcript.maxLines = 3;
    transcript.append("aaaa\nbbbb\ncccc");
    expect(transcript.desiredHeight(2)).toBe(6);

    transcript.append("dd");
    expect(transcript.lines.map(line => line.text)).toEqual(["bbbb", "cccc", "dd"]);
    expect(transcript.desiredHeight(2)).toBe(5);
    expect(transcript.maxScrollOffset(1, 2)).toBe(4);
  });

  it("ignores out-of-range line replacements and empty wrapped row windows", () => {
    const transcript = new Transcript();
    transcript.append("alpha");

    transcript.replaceLine(-1, "nope");
    transcript.replaceLine(5, "nope");

    expect(transcript.lines.map(line => line.text)).toEqual(["alpha"]);
    expect(transcript.wrappedRowsRange(5, 3, 3)).toEqual([]);
    expect(transcript.wrappedRowsRange(5, 4, 2)).toEqual([]);
  });
});

describe("AssistantStream", () => {
  it("keeps consecutive content deltas on the same assistant line", () => {
    const transcript = new Transcript();
    transcript.append("› hello");
    const stream = new AssistantStream();

    stream.append(transcript, "Hello");
    stream.append(transcript, "!");
    stream.append(transcript, " Ready");

    expect(transcript.lines.map(line => line.text)).toEqual(["› hello", "Hello! Ready"]);
  });

  it("rerenders Markdown across streaming chunks", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "- **Create");
    stream.append(transcript, " a new project** called `nh`");

    const plain = transcript.lines.map(line => stripAnsi(line.text));
    expect(plain).toEqual(["• Create a new project called nh"]);
    expect(transcript.lines[0].text).not.toContain("**");
    expect(transcript.lines[0].text).not.toContain("`");
  });

  it("rerenders multiline Markdown without duplicating streamed rows", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "- item one\n```ts\nconst x");
    stream.append(transcript, " = 1;\n```");

    expect(transcript.lines.map(line => stripAnsi(line.text))).toEqual([
      "• item one",
      "  │ ts",
      "  │ const x = 1;",
      "  │",
    ]);
  });

  it("starts a new assistant line after reset", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream();

    stream.append(transcript, "first");
    stream.reset();
    stream.append(transcript, "second");

    expect(transcript.lines.map(line => line.text)).toEqual(["first", "second"]);
  });

  it("reuses an existing blank transcript line for the first streamed chunk", () => {
    const transcript = new Transcript();
    transcript.append("");
    const stream = new AssistantStream();

    stream.append(transcript, "hello");

    expect(transcript.lines.map(line => stripAnsi(line.text))).toEqual(["hello"]);
  });
});

describe("TuiRuntimeViewModel", () => {
  it("projects runtime events into transcript and view state", () => {
    const transcript = new Transcript();
    let renderNowCount = 0;
    let requestRenderCount = 0;
    let now = 2_000;
    const view = new TuiRuntimeViewModel(transcript, {
      thinkingVisible: () => true,
      turnStartedAt: () => 1_000,
      now: () => now,
      renderNow: () => { renderNowCount++; },
      requestRender: () => { requestRenderCount++; },
      enableThinkingTimer: false,
    });
    let storeNotifications = 0;
    const unsubscribe = view.subscribe(() => { storeNotifications++; });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "api_call_start", data: {} } as any);
    expect(stripAnsi(view.activeStatusLine || "")).toContain("Thinking 0s");

    view.handleRuntimeEvent({ type: "thinking_delta", data: { text: "- **Plan**" } } as any);
    now = 2_500;
    view.handleRuntimeEvent({ type: "content_delta", data: { text: "Answer" } } as any);
    let plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Plan");
    expect(plain).toContain("Answer");

    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "edit", tool_call_id: "call-1" } } as any);
    expect(view.activeToolCount).toBe(1);
    const linesAfterBegin = transcript.lines.length;
    view.handleRuntimeEvent({ type: "tool_call", data: { id: "call-1", name: "edit", arguments: {} } } as any);
    expect(transcript.lines).toHaveLength(linesAfterBegin);

    view.handleRuntimeEvent({
      type: "tool_progress",
      data: { tool: "edit", tool_call_id: "call-1", progress: { message: "halfway" } },
    } as any);
    plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("halfway");

    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-1", name: "edit", content: "ok", is_error: false },
      preview: [
        "Successfully edited file.ts",
        "",
        "[diff]",
        "  -- file.ts --",
        "- old",
        "+ new",
      ].join("\n"),
    } as any);
    plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(view.activeToolCount).toBe(0);
    expect(plain).toContain("file.ts");
    expect(plain).toContain("+ new");

    view.finishTurn();
    expect(view.activeStatusLine).toBeNull();
    expect(storeNotifications).toBeGreaterThan(0);
    expect(renderNowCount).toBeGreaterThan(0);
    expect(requestRenderCount).toBeGreaterThan(0);
    unsubscribe();
    view.dispose();
  });

  it("upgrades write tool activity from streamed args before completion", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "write", tool_call_id: "call-write-1" } } as any);
    expect(stripAnsi(transcript.lines.at(-1)?.text || "")).toContain("Writing file");

    view.handleRuntimeEvent({
      type: "tool_call_args",
      data: {
        tool_call_id: "call-write-1",
        name: "write",
        arguments: "{\"path\":\"src/components/ToolPanel.tsx\"",
      },
    } as any);

    expect(stripAnsi(transcript.lines.at(-1)?.text || "")).toContain("Writing src/components/ToolPanel.tsx");

    view.handleRuntimeEvent({
      type: "tool_progress",
      data: {
        tool: "write",
        tool_call_id: "call-write-1",
        progress: { message: "writing bytes" },
      },
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Writing src/components/ToolPanel.tsx");
    expect(plain).toContain("writing bytes");
  });

  it("uses runtime tool metadata for activity and compact result labels", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "custom_tool", tool_call_id: "call-custom" } } as any);
    view.handleRuntimeEvent({
      type: "tool_call",
      data: {
        id: "call-custom",
        name: "custom_tool",
        arguments: {},
        metadata: { activity: "Auditing workspace" },
      },
    } as any);
    expect(stripAnsi(transcript.lines.at(-1)?.text || "")).toContain("Auditing workspace");

    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-custom", name: "custom_tool", content: "ok", is_error: false },
      preview: "ok",
      metadata: { summary: "Workspace audit" },
    } as any);

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Workspace audit");
  });

  it("keeps concurrent write tool lines associated by tool call id", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    view.beginTurn();
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "write", tool_call_id: "call-1" } } as any);
    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "write", tool_call_id: "call-2" } } as any);
    view.handleRuntimeEvent({
      type: "tool_call",
      data: { id: "call-1", name: "write", arguments: { path: "a.ts", content: "a" } },
    } as any);
    view.handleRuntimeEvent({
      type: "tool_call",
      data: { id: "call-2", name: "write", arguments: { path: "b.ts", content: "b" } },
    } as any);
    view.handleRuntimeEvent({
      type: "tool_result",
      data: { tool_call_id: "call-2", name: "write", content: "ok", is_error: false },
      preview: "Successfully wrote 1 bytes to b.ts",
    } as any);

    const plainLines = transcript.lines.map(line => stripAnsi(line.text));
    expect(plainLines.some(line => line.includes("Writing a.ts"))).toBe(true);
    expect(plainLines.some(line => line.includes("Successfully wrote 1 bytes to b.ts"))).toBe(true);
    expect(view.activeToolCount).toBe(1);
  });

  it("rebuilds a loaded session transcript without leaking runtime state", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const session = createSession({
      id: "session-1",
      title: "Proof session",
      messages: [
        { role: "system", content: "system", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "user", content: "prove it", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
        { role: "assistant", content: "**Done**", tool_calls: null, tool_call_id: null, name: null, reasoning_content: "private plan" },
        { role: "tool", content: "ok", tool_calls: null, tool_call_id: "call-1", name: "read_file", reasoning_content: null, is_error: false },
      ],
    });

    view.handleRuntimeEvent({ type: "tool_call_begin", data: { name: "edit", tool_call_id: "call-2" } } as any);
    expect(view.activeToolCount).toBe(1);

    view.renderSessionTranscript({
      session,
      loaded: true,
      version: "0.2.0",
      model: "deepseek-v4-pro",
      mode: "agent",
      toolCount: 12,
    });

    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));
    expect(plain).toContain("Seek Code");
    expect(plain).toContain("Loaded session: Proof session");
    expect(plain).toContain("prove it");
    expect(plain).toContain("private plan");
    expect(plain).toContain("Done");
    expect(plain).toContain("read_file");
    expect(view.activeToolCount).toBe(0);
    expect(view.activeStatusLine).toBeNull();
  });

  it("replays session messages through runtime events", () => {
    const events = sessionMessagesToRuntimeEvents([
      { role: "system", content: "system", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      { role: "user", content: "inspect", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      {
        role: "assistant",
        content: "Calling tool",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
        tool_call_id: null,
        name: null,
        reasoning_content: "need file",
      },
      { role: "tool", content: "file content", tool_calls: null, tool_call_id: "call-1", name: "read_file", reasoning_content: null, is_error: false },
    ]);
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    expect(events.map(event => event.type)).toEqual(["user_message", "assistant_message", "tool_call", "tool_result"]);
    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("inspect");
    expect(plain).toContain("need file");
    expect(plain).toContain("Calling tool");
    expect(plain).toContain("read_file");
    expect(plain).toContain("file content");
    expect(view.activeToolCount).toBe(0);
  });

  it("replays compaction boundaries as prefix invalidation events", () => {
    const events = sessionMessagesToRuntimeEvents([
      {
        role: "system",
        content: [
          "[Context compaction boundary]",
          "boundary_id: compact_test",
          "projected_tokens_before: 400",
          "projected_tokens_after: 120",
          "preserve_from_index: 6",
          "removed_messages: 10",
          "preserved_messages: 4",
          "actions:",
          "- summary boundary appended",
        ].join("\n"),
        tool_calls: null,
        tool_call_id: null,
        name: "context_compaction_boundary",
        reasoning_content: null,
      },
      {
        role: "system",
        content: "[Earlier conversation summarized for boundary compact_test]\n- user: earlier",
        tool_calls: null,
        tool_call_id: null,
        name: "context_summary",
        reasoning_content: null,
      },
      { role: "user", content: "continue", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
    ]);
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });

    expect(events.map(event => event.type)).toEqual(["prefix_invalidated", "user_message"]);
    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("Prompt cache reset");
    expect(plain).toContain("compact_test");
    expect(plain).toContain("continue");
  });

  it("replays server runtime items without duplicating final assistant messages", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "user_message", data: { text: "hello" } },
      { type: "api_call_start", data: {} },
      { type: "content_delta", data: { text: "Hi" } },
      {
        type: "assistant_message",
        data: { role: "assistant", content: "Hi", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("hello");
    expect(plain.match(/\bHi\b/g)).toHaveLength(1);
  });

  it("replays approval_required runtime items as denied tool status", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "tool_call_begin", data: { name: "write", tool_call_id: "call-write-1" } },
      { type: "approval_required", data: { tool: "write", args: { path: "draft.txt", content: "hello" } } },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("write");
    expect(plain).toContain("Approval required");
    expect(plain).toContain("draft.txt");
  });

  it("ignores unknown runtime item types during replay conversion", () => {
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "mystery", data: { value: 1 } },
      { type: "content_delta", data: { text: "kept" } },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "content_delta", data: { text: "kept" } });
  });

  it("does not replay malformed persisted runtime items as [object Object] transcript content", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "user_message", data: { text: { nested: true } as any } },
      { type: "tool_call_begin", data: { name: { nested: true } as any, tool_call_id: "call-1" } },
      { type: "approval_required", data: { tool: { nested: true } as any, args: { path: "draft.txt" } } },
      { type: "content_delta", data: { text: "kept" } },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("kept");
    expect(plain).not.toContain("[object Object]");
    expect(plain).not.toContain("draft.txt");
  });

  it("sanitizes malformed replayed context and prefix runtime items instead of rendering object coercions", () => {
    const transcript = new Transcript();
    const view = new TuiRuntimeViewModel(transcript, { enableThinkingTimer: false });
    const events = runtimeItemsToEngineRuntimeEvents([
      {
        type: "context_intervention",
        data: {
          risk: { nested: true } as any,
          action: ["verify"] as any,
          reason: { nested: true } as any,
          compaction: { message: { nested: true } as any },
        },
      },
      {
        type: "prefix_invalidated",
        data: {
          reason: { nested: true } as any,
          boundary_id: { nested: true } as any,
          compaction: {
            finalTokens: "900" as any,
            removed_messages: { nested: true } as any,
            preserved_messages: ["3"] as any,
          },
        },
      },
      { type: "content_delta", data: { text: "kept" } },
    ]);

    view.replayRuntimeEvents(events);
    const plain = stripAnsi(transcript.lines.map(line => line.text).join("\n"));

    expect(plain).toContain("Context guard: unknown / intervention");
    expect(plain).toContain("Prompt cache reset: unknown");
    expect(plain).toContain("kept");
    expect(plain).not.toContain("[object Object]");
    expect(plain).not.toContain("boundary [object Object]");
    expect(plain).not.toContain("900 projected tokens");
  });

  it("marks tool replay results as errors when persisted content is denial text", () => {
    const events = sessionMessagesToRuntimeEvents([
      {
        role: "tool",
        content: "write was denied.",
        tool_calls: null,
        tool_call_id: "call-1",
        name: "write",
        reasoning_content: null,
        is_error: null,
      },
    ]);

    expect(events).toMatchObject([
      {
        type: "tool_result",
        data: {
          tool_call_id: "call-1",
          name: "write",
          is_error: true,
        },
      },
    ]);
  });
});

describe("Markdown renderer", () => {
  it("renders common markdown constructs for terminal output", () => {
    const rendered = renderMarkdown([
      "# Title",
      "",
      "- **Bold** and *italic* and `code`",
      "> quoted",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n"));

    const plain = stripAnsi(rendered).split("\n");
    expect(plain).toEqual([
      "Title",
      "",
      "• Bold and italic and code",
      "│ quoted",
      "  │ ts",
      "  │ const x = 1;",
      "  │",
    ]);
  });

  it("renders single-star emphasis without leaking markdown markers", () => {
    const rendered = renderMarkdown("This is *2025* and **bold**");
    const plain = stripAnsi(rendered);

    expect(plain).toBe("This is 2025 and bold");
    expect(rendered).not.toContain("*2025*");
  });

  it("keeps ordinary single stars when they are not emphasis", () => {
    const rendered = renderMarkdown("Math stays 2 * 3 * 4 and unfinished *text");

    expect(stripAnsi(rendered)).toBe("Math stays 2 * 3 * 4 and unfinished *text");
  });
});

describe("Renderer", () => {
  it("shows a blue cat in the welcome banner without the tools row", () => {
    const banner = welcomeBanner("0.1.0", "deepseek-v4-pro", "agent", 26);
    const plain = stripAnsi(banner);

    expect(plain).toContain("Seek Code");
    expect(plain).toContain("/\\_____/\\");
    expect(plain).toContain("( ==  ^  == )");
    expect(plain).toContain("deepseek-v4-pro · agent");
    expect(plain).not.toContain("Tools:");
  });

  it("keeps status bar within terminal width", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 40;
    try {
      expect(visibleLength(statusBar("agent", "deepseek-v4-pro", 1234, 0.12, "Tab complete"))).toBe(40);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("shows the current mode in the footer status bar", () => {
    expect(stripAnsi(statusBar("yolo", "deepseek-v4-pro", 0, 0, "Shift+Tab mode"))).toContain("YOLO");
  });

  it("shows the current folder in the footer status bar", () => {
    expect(stripAnsi(statusBar("agent", "deepseek-v4-pro", 0, 0, "Tab complete", "seek-code"))).toContain("seek-code");
  });

  it("renders configurable status items with context, cache, tools, and elapsed", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 100;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "context", "cache", "tools", "elapsed", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        tokens: 12_300,
        contextLimit: 1_000_000,
        cacheTokens: 9000,
        activeTools: 2,
        elapsedMs: 65_000,
        keyHints: "Tab complete",
      }));

      expect(rendered).toContain("AGENT");
      expect(rendered).toContain("ctx 12k/1.0M");
      expect(rendered).toContain("cache 9.0k");
      expect(rendered).toContain("tools 2");
      expect(rendered).toContain("elapsed 1m05s");
      expect(rendered).toContain("Tab complete");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("hides the tools status item when no tools are active", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 100;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "tools", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        activeTools: 0,
        keyHints: "Tab complete",
      }));

      expect(rendered).toContain("AGENT");
      expect(rendered).not.toContain("tools 0");
      expect(rendered).toContain("Tab complete");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("keeps the default footer focused without context, cache, cost, or hints", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 120;
    try {
      const rendered = stripAnsi(statusBarFromItems([], {
        mode: "agent",
        model: "deepseek-v4-pro",
        workspace: "/ssd/yqy/projects/seek-code",
        tokens: 42_000,
        contextLimit: 1_000_000,
        cacheTokens: 7300,
        elapsedMs: 12_000,
        cost: 0.001,
        keyHints: "esc to interrupt  Shift+Tab switch mode",
      }));

      expect(rendered).toContain("AGENT");
      expect(rendered).toContain("deepseek-v4-pro");
      expect(rendered).toContain("/ssd/yqy/projects/seek-code");
      expect(rendered).not.toContain("ctx ");
      expect(rendered).not.toContain("cache ");
      expect(rendered).not.toContain("elapsed ");
      expect(rendered).not.toContain("$");
      expect(rendered).not.toContain("esc");
      expect(rendered).not.toContain("Tab complete");
      expect(rendered).not.toContain("tools ");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("shows Esc interrupt in footer hints", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 120;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        keyHints: "Esc interrupt  Tab complete",
      }));

      expect(rendered).toContain("Esc interrupt");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("keeps interrupt hints visible on narrow footers", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 44;
    try {
      const rendered = stripAnsi(statusBarFromItems(["mode", "model", "workspace", "hints"], {
        mode: "agent",
        model: "deepseek-v4-pro",
        workspace: "/ssd/yqy/projects/seek-code",
        keyHints: "esc to interrupt  Shift+Tab switch mode",
      }));

      expect(rendered).toContain("esc to interrupt");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("shows elapsed time and interrupt hint in thinking header", () => {
    const rendered = stripAnsi(thinkingHeader(1250, true));

    expect(rendered).toContain("Thinking 1s · esc to interrupt");
    expect(rendered).not.toContain("...");
  });

  it("renders a live thinking status line without a leading newline", () => {
    const rendered = stripAnsi(thinkingStatusLine(1250, true));

    expect(rendered.startsWith("\n")).toBe(false);
    expect(rendered).toContain("Thinking 1s · esc to interrupt");
  });

  it("keeps elapsed time when interrupt hint is hidden", () => {
    const rendered = stripAnsi(thinkingStatusLine(65_000, false));

    expect(rendered).toContain("Thinking 1m05s");
    expect(rendered).not.toContain("esc to interrupt");
  });

  it("updates a thinking line in place", () => {
    const transcript = new Transcript();
    transcript.append(thinkingStatusLine(0, true));
    transcript.replaceLine(0, thinkingStatusLine(2100, true));

    expect(stripAnsi(transcript.lines[0].text)).toContain("Thinking 2s");
    expect(transcript.lines).toHaveLength(1);
  });

  it("renders compact diff previews from tool output", () => {
    const rendered = stripAnsi(toolDiffPreview([
      "Successfully edited file.ts",
      "",
      "[diff]",
      "  ── file.ts ──",
      "- old line",
      "+ new line",
    ].join("\n")));

    expect(rendered).toContain("file.ts");
    expect(rendered).toContain("- old line");
    expect(rendered).toContain("+ new line");
  });

  it("wraps thinking text with consistent indentation", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 14;
    try {
      const lines = thinkingText("abcdef ghijkl").split("\n");

      expect(lines.length).toBeGreaterThan(1);
      expect(lines.every(line => stripAnsi(line).startsWith("  "))).toBe(true);
      expect(lines.every(line => visibleLength(line) <= 14)).toBe(true);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  it("lightly renders markdown inside thinking text", () => {
    const renderedRaw = thinkingText(["- **Plan** with *emphasis* and `code`", "> quote"].join("\n"));
    const rendered = stripAnsi(renderedRaw);

    expect(rendered).toContain("  • Plan with emphasis and code");
    expect(rendered).toContain("  │ quote");
    expect(rendered).not.toContain("**");
    expect(rendered).not.toContain("*emphasis*");
    expect(rendered).not.toContain("`");
  });

  it("keeps footer divider valid on very narrow terminals", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 5;
    try {
      expect(() => footerDivider("session-id-too-long")).not.toThrow();
      expect(visibleLength(footerDivider("session-id-too-long"))).toBe(5);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });
});

describe("Input shortcuts", () => {
  it("recognizes common Shift+Tab terminal sequences", () => {
    expect(isShiftTabSequence("\x1b[Z")).toBe(true);
    expect(isShiftTabSequence("\x1b[1;2Z")).toBe(true);
    expect(isShiftTabSequence("\t")).toBe(false);
  });

  it("pauses stdin again after raw input cleanup", () => {
    let rawMode: boolean | undefined;
    let paused = false;

    restoreTTYInput({
      setRawMode(value: boolean) { rawMode = value; return this as any; },
      pause() { paused = true; return this as any; },
    }, undefined);

    expect(rawMode).toBe(false);
    expect(paused).toBe(true);
  });

  it("moves cursor by Unicode grapheme code points instead of UTF-16 halves", () => {
    const value = "a🙂你";

    expect(nextGraphemeIndex(value, 1)).toBe(3);
    expect(previousGraphemeIndex(value, 3)).toBe(1);
    expect(nextGraphemeIndex(value, 3)).toBe(4);
    expect(previousGraphemeIndex(value, value.length)).toBe(3);
  });

  it("maps terminal scroll keys and mouse wheel events", () => {
    expect(scrollActionForSequence("\x1b[5~")).toEqual({ direction: "up", amount: 8 });
    expect(scrollActionForSequence("\x1b[6~")).toEqual({ direction: "down", amount: 8 });
    expect(scrollActionForSequence("\x1b[5;2~")).toEqual({ direction: "up", amount: 8 });
    expect(scrollActionForSequence("\x1b[6;2~")).toEqual({ direction: "down", amount: 8 });
    expect(scrollActionForSequence("\x1b[1;5H")?.direction).toBe("top");
    expect(scrollActionForSequence("\x1b[1;5F")?.direction).toBe("bottom");
    expect(scrollActionForSequence("\x1b[H")).toBeNull();
    expect(scrollActionForSequence("\x1b[F")).toBeNull();
    expect(scrollActionForSequence("\x1b[<64;10;5M")).toEqual({ direction: "up", amount: 3 });
    expect(scrollActionForSequence("\x1b[<65;10;5M")).toEqual({ direction: "down", amount: 3 });
  });

  it("keeps mouse escape sequences out of printable input chunks", () => {
    expect(splitInputSequences("a\x1b[<64;10;5Mb")).toEqual(["a", "\x1b[<64;10;5M", "b"]);
    expect(splitInputSequences("\x1b[5~hello")).toEqual(["\x1b[5~", "h", "e", "l", "l", "o"]);
    expect(splitInputSequences("qwq")).toEqual(["q", "w", "q"]);
  });

  it("coalesces printable input bursts before editing the prompt", () => {
    expect(isPlainTextInputSequence("hello")).toBe(true);
    expect(isPlainTextInputSequence("hello\n")).toBe(false);
    expect(coalesceInputSequences(splitInputSequences("hello"))).toEqual(["hello"]);
    expect(coalesceInputSequences(splitInputSequences("hi\x1b[D!"))).toEqual(["hi", "\x1b[D", "!"]);
  });

  it("recognizes bracketed paste delimiters", () => {
    const keys = splitInputSequences("\x1b[200~hello\nworld\x1b[201~");

    expect(isBracketedPasteStart(keys[0]!)).toBe(true);
    expect(isBracketedPasteEnd(keys.at(-1)!)).toBe(true);
    expect(keys).toContain("\n");
  });

  it("coalesces bracketed paste payloads including newlines", () => {
    const keys = splitInputSequences("\x1b[200~hello\nworld\x1b[201~");

    expect(coalesceInputSequences(keys)).toEqual(["\x1b[200~", "hello\nworld", "\x1b[201~"]);
  });

  it("coalesces text while already inside bracketed paste mode", () => {
    expect(coalesceInputSequences(["hello", "\n", "world"], { inBracketedPaste: true })).toEqual(["hello\nworld"]);
  });

  it("treats newlines in paste-like bursts as input text", () => {
    expect(shouldTreatNewlineAsPaste(5, 12, 1000, 0)).toBe(true);
    expect(shouldTreatNewlineAsPaste(0, 1, 1000, 1001)).toBe(true);
    expect(shouldTreatNewlineAsPaste(1, 2, 1000, 0)).toBe(false);
    expect(shouldTreatNewlineAsPaste(0, 1, 1000, 999)).toBe(false);
  });

  it("emits terminal bracketed paste mode sequences", () => {
    const chunks: string[] = [];
    const out = { write(chunk: string) { chunks.push(chunk); return true; } };

    enableBracketedPaste(out as any);
    disableBracketedPaste(out as any);

    expect(chunks).toEqual(["\x1b[?2004h", "\x1b[?2004l"]);
  });

  it("includes session deletion in command completion data", () => {
    expect(COMMANDS.map(([name]) => name)).toContain("delete");
  });

  it("detects incomplete escape prefixes for split terminal keys", () => {
    expect(trailingIncompleteEscapeStart("\x1b")).toBe(0);
    expect(trailingIncompleteEscapeStart("abc\x1b[")).toBe(3);
    expect(trailingIncompleteEscapeStart("abc\x1b[<64;10")).toBe(3);
    expect(trailingIncompleteEscapeStart("abc\x1b[5~")).toBe(-1);
  });

  it("keeps split mouse wheel escape prefixes pending until complete", () => {
    expect(trailingIncompleteEscapeStart("abc\x1b[<64;10;")).toBe(3);
    expect(splitInputSequences("\x1b[<64;10;5M")).toEqual(["\x1b[<64;10;5M"]);
  });

  it("recognizes incomplete SS3 escape prefixes", () => {
    expect(trailingIncompleteEscapeStart("abc\x1bO")).toBe(3);
  });
});

describe("InputController", () => {
  it("edits, completes, and submits prompt input through one state machine", () => {
    const renders: Array<{ value: string; cursor: number; completions: string[] }> = [];
    const submissions: string[] = [];
    const controller = new InputController({
      mode: "idle",
      completionProvider: commandCompletionProvider,
      onRender: (state) => {
        renders.push({ value: state.value, cursor: state.cursor, completions: state.completions });
      },
      onSubmit: (value) => {
        submissions.push(value);
        return true;
      },
    });

    controller.handleData("/");
    controller.handleData("t");
    controller.handleData("a");
    expect(controller.getState()).toMatchObject({ value: "/ta", cursor: 3 });
    expect(controller.getState().completions.map(stripAnsi).join("\n")).toContain("/tasks");

    controller.handleData("\t");
    expect(controller.getState()).toMatchObject({ value: "/tasks ", cursor: 7 });

    controller.handleData("n");
    controller.handleData("o");
    controller.handleData("w");
    controller.handleData("\x1b[D");
    controller.handleData("\x7f");
    controller.handleData("\r");

    expect(submissions).toEqual(["/tasks nw"]);
    expect(renders.length).toBeGreaterThan(0);
  });

  it("keeps paste newlines as text and submits after paste ends", () => {
    const submissions: string[] = [];
    let now = 1_000;
    const controller = new InputController({
      mode: "running",
      clearOnSubmit: true,
      now: () => now,
      onSubmit: (value) => {
        submissions.push(value);
        return true;
      },
    });

    controller.handleData("\x1b[200~hello\nworld\x1b[201~");
    expect(controller.getState().value).toBe("hello\nworld");

    now = 1_200;
    controller.handleData("\r");
    expect(submissions).toEqual(["hello\nworld"]);
    expect(controller.getState().value).toBe("");
  });

  it("routes scroll, mode cycle, and interrupts without duplicating parsers", () => {
    const scrolls: string[] = [];
    let interrupted = 0;
    let mode = "idle";
    const controller = new InputController({
      mode: "idle",
      prompt: "a",
      onModeCycle: () => {
        mode = "running";
        return "b";
      },
      onScroll: (direction, amount) => {
        scrolls.push(`${direction}:${amount}`);
      },
      onInterrupt: () => {
        interrupted++;
        return false;
      },
    });

    controller.handleData("\x1b[5~");
    controller.handleData("\x1b[Z");
    controller.handleSequences(["\x1b"]);

    expect(scrolls).toEqual(["up:8"]);
    expect(mode).toBe("running");
    expect(controller.getState().prompt).toBe("b");
    expect(interrupted).toBe(1);
  });

  it("blocks mode cycling while running and explains why", () => {
    const notices: string[] = [];
    const controller = new InputController({
      mode: "running",
      prompt: "● ",
      onModeCycle: () => denyModeSwitchWhileRunning(message => notices.push(message), "● "),
    });

    controller.handleData("\x1b[Z");

    expect(controller.getState().prompt).toBe("● ");
    expect(notices).toHaveLength(1);
    expect(stripAnsi(notices[0]!)).toContain(RUNNING_MODE_SWITCH_BLOCKED_MESSAGE);
  });

  it("clears the current input on ctrl+c instead of treating it as exit", () => {
    let ctrlCCount = 0;
    const controller = new InputController({
      mode: "idle",
      onCtrlC: () => {
        ctrlCCount++;
        controller.reset({ render: false });
        return false;
      },
    });

    controller.handleData("hello");
    expect(controller.getState()).toMatchObject({ value: "hello", cursor: 5 });

    controller.handleData("\x03");

    expect(ctrlCCount).toBe(1);
    expect(controller.getState()).toMatchObject({ value: "", cursor: 0 });
  });

  it("passes picker and approval keys through the shared parser without editing text", () => {
    const pickerKeys: string[] = [];
    const picker = new InputController({
      mode: "picker",
      editable: false,
      onUnhandledSequence: (sequence) => {
        pickerKeys.push(sequence);
        return false;
      },
    });

    picker.handleData("\x1b[5~");
    picker.handleData("\x1b[H");
    picker.handleData("y");

    expect(pickerKeys).toEqual(["\x1b[5~", "\x1b[H", "y"]);
    expect(picker.getState()).toMatchObject({ value: "", cursor: 0 });

    const approvals: string[] = [];
    const approval = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        approvals.push(sequence);
        return true;
      },
    });

    approval.handleData("always");
    expect(approvals).toEqual(["always"]);
    expect(approval.getState().value).toBe("");
  });

  it("passes Esc through approval mode so modal handlers can cancel without editing text", async () => {
    const sequences: string[] = [];
    vi.useFakeTimers();
    const approval = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        sequences.push(sequence);
        return true;
      },
    });

    approval.handleData("\x1b");
    await vi.advanceTimersByTimeAsync(30);

    expect(sequences).toEqual(["\x1b"]);
    expect(approval.getState()).toMatchObject({ value: "", cursor: 0 });
    vi.useRealTimers();
  });

  it("flushes a pending bare escape on dispose without mutating input state", async () => {
    vi.useFakeTimers();
    const interrupts: string[] = [];
    const controller = new InputController({
      mode: "idle",
      onInterrupt: () => {
        interrupts.push("interrupt");
        return false;
      },
    });

    controller.handleData("\x1b");
    controller.dispose();
    await vi.advanceTimersByTimeAsync(30);

    expect(interrupts).toEqual([]);
    expect(controller.getState()).toMatchObject({ value: "", cursor: 0, inBracketedPaste: false });
    vi.useRealTimers();
  });

  it("flushes a split escape sequence after the pending timeout", async () => {
    const sequences: string[] = [];
    vi.useFakeTimers();
    const controller = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        sequences.push(sequence);
        return true;
      },
    });

    controller.handleData("\x1b");
    await vi.advanceTimersByTimeAsync(30);

    expect(sequences).toEqual(["\x1b"]);
    vi.useRealTimers();
  });

  it("treats shift-tab as pasted text while inside bracketed paste mode", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("\x1b[200~");
    controller.handleData("\x1b[Z");
    controller.handleData("\x1b[201~");

    expect(controller.getState().value).toBe("\x1b[Z");
  });

  it("keeps escape-prefixed navigation sequences from editing approval input", () => {
    const sequences: string[] = [];
    const controller = new InputController({
      mode: "approval",
      editable: false,
      onUnhandledSequence: (sequence) => {
        sequences.push(sequence);
        return true;
      },
    });

    controller.handleData("\x1b[C");
    controller.handleData("\x1b[D");

    expect(sequences).toEqual(["\x1b[C", "\x1b[D"]);
    expect(controller.getState().value).toBe("");
  });

  it("detaches raw input listeners idempotently and restores bracketed paste only once", () => {
    const writes: string[] = [];
    let rawMode: boolean | undefined;
    let resumeCount = 0;
    let pauseCount = 0;
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const stdin = {
      isRaw: false,
      setRawMode(value: boolean) { rawMode = value; return this; },
      resume() { resumeCount++; return this; },
      pause() { pauseCount++; return this; },
      on(event: string, handler: (...args: any[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
        return this;
      },
      removeListener(event: string, handler: (...args: any[]) => void) {
        listeners.get(event)?.delete(handler);
        return this;
      },
    };
    const controller = new InputController();

    const detach = controller.attach({
      stdin: stdin as any,
      stdout: { write(chunk: string) { writes.push(chunk); return true; } },
      rawMode: true,
      bracketedPaste: true,
      pauseOnStop: true,
    });

    detach();
    detach();

    expect(writes).toEqual(["\x1b[?2004h", "\x1b[?2004l"]);
    expect(rawMode).toBe(false);
    expect(resumeCount).toBe(1);
    expect(pauseCount).toBe(1);
    expect(listeners.get("data")?.size ?? 0).toBe(0);
  });

  it("does not treat ctrl+d as eof while text is present", () => {
    let eofCount = 0;
    const controller = new InputController({
      mode: "idle",
      onEof: () => {
        eofCount++;
        return true;
      },
    });

    controller.handleData("hello");
    controller.handleData("\x04");

    expect(eofCount).toBe(0);
    expect(controller.getState().value).toBe("hello");
  });

  it("supports ctrl+a and ctrl+e cursor movement shortcuts", () => {
    const controller = new InputController({ mode: "idle" });

    controller.handleData("hello");
    controller.handleData("\x01");
    expect(controller.getState().cursor).toBe(0);

    controller.handleData("\x05");
    expect(controller.getState().cursor).toBe(5);
  });

  it("updates the prompt through setPrompt and emits a mode render", () => {
    const prompts: string[] = [];
    const controller = new InputController({
      mode: "idle",
      onRender: (state, meta) => {
        prompts.push(`${state.prompt}:${meta.reason}`);
      },
    });

    controller.setPrompt("next> ");

    expect(controller.getState().prompt).toBe("next> ");
    expect(prompts).toContain("next> :mode");
  });

  it("updates mode through setMode and emits a mode render", () => {
    const renders: string[] = [];
    const controller = new InputController({
      mode: "idle",
      onRender: (state, meta) => {
        renders.push(`${state.mode}:${meta.reason}`);
      },
    });

    controller.setMode("running");

    expect(controller.getState().mode).toBe("running");
    expect(renders).toContain("running:mode");
  });
});

describe("Picker", () => {
  it("keeps the selected item inside a sliding visible window", () => {
    const items = Array.from({ length: 20 }, (_, index) => `session-${index}`);

    expect(pickerWindow(items, 0, 5)).toMatchObject({
      start: 0,
      end: 5,
      selectedIndex: 0,
    });

    const middle = pickerWindow(items, 10, 5);
    expect(middle.entries.map(entry => entry.item)).toEqual([
      "session-8",
      "session-9",
      "session-10",
      "session-11",
      "session-12",
    ]);
    expect(middle.entries.find(entry => entry.selected)?.item).toBe("session-10");

    expect(pickerWindow(items, 19, 5)).toMatchObject({
      start: 15,
      end: 20,
      selectedIndex: 19,
    });
  });

  it("maps navigation keys for session pickers", () => {
    expect(pickerActionForSequence("\x1b[A")).toBe("up");
    expect(pickerActionForSequence("\x1b[B")).toBe("down");
    expect(pickerActionForSequence("\x1b[5~")).toBe("page_up");
    expect(pickerActionForSequence("\x1b[6~")).toBe("page_down");
    expect(pickerActionForSequence("\x1b[H")).toBe("top");
    expect(pickerActionForSequence("\x1b[F")).toBe("bottom");
    expect(pickerActionForSequence("\x1b[<64;10;5M")).toBe("up");
    expect(pickerActionForSequence("\x1b[<65;10;5M")).toBe("down");
    expect(pickerActionForSequence("\r")).toBe("confirm");
    expect(pickerActionForSequence("\x1b")).toBe("cancel");
  });

  it("moves through long picker lists without wrapping away from old sessions", () => {
    expect(movePickerIndex(0, 20, "up", 5)).toBe(0);
    expect(movePickerIndex(0, 20, "down", 5)).toBe(1);
    expect(movePickerIndex(3, 20, "page_down", 5)).toBe(8);
    expect(movePickerIndex(18, 20, "page_down", 5)).toBe(19);
    expect(movePickerIndex(8, 20, "page_up", 5)).toBe(3);
    expect(movePickerIndex(8, 20, "top", 5)).toBe(0);
    expect(movePickerIndex(8, 20, "bottom", 5)).toBe(19);
  });

  it("returns an empty picker window when there is no space to show items", () => {
    expect(pickerWindow(["a", "b"], 0, 0)).toEqual({
      start: 0,
      end: 0,
      selectedIndex: -1,
      total: 2,
      entries: [],
    });
  });
});

describe("TUI modal requests", () => {
  it("renders picker modal lines from structured state", () => {
    const lines = pickerModalLines(
      3,
      Array.from({ length: 6 }, (_, index) => ({ name: `item-${index}`, desc: `desc-${index}` })),
      "Select item",
      3,
    ).map(stripAnsi);

    expect(lines.join("\n")).toContain("item-3");
    expect(lines.join("\n")).toContain("desc-3");
    expect(lines.at(-1)).toContain("Select item");
  });

  it("renders approval modal lines without transcript writes", () => {
    const text = approvalModalLines("bash", { command: "npm test" }).map(stripAnsi).join("\n");

    expect(text).toContain("Approval required: bash");
    expect(text).toContain("command=npm test");
    expect(text).toContain("y yes");
  });
});

describe("Modes", () => {
  it("cycles through interactive modes", () => {
    expect(nextModeName("plan")).toBe("agent");
    expect(nextModeName("agent")).toBe("yolo");
    expect(nextModeName("yolo")).toBe("plan");
    expect(nextModeName("unknown")).toBe("agent");
  });
});

describe("Alternate screen mode", () => {
  it("keeps inline mode as the scrollback-preserving default", () => {
    expect(shouldUseAlternateScreen("never")).toBe(false);
    expect(shouldUseAlternateScreen("always")).toBe(true);
  });

  it("disables auto alternate screen inside Zellij", () => {
    expect(shouldUseAlternateScreen("auto", { ZELLIJ: "1" })).toBe(false);
    expect(shouldUseAlternateScreen("auto", {})).toBe(true);
  });
});

describe("FrameRenderer", () => {
  it("diffs frames and can wrap writes in synchronized output", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: true,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      env: { SEEKCODE_TUI_SYNC_OUTPUT: "1" } as any,
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
    });

    const first = renderer.render(["alpha", "beta"], { cursor: { row: 2, col: 3 } });
    expect(first).toMatchObject({ changedRows: 2, totalRows: 2, fullRepaint: true });
    expect(chunks.join("")).toContain("\x1b[?2026h");
    expect(chunks.join("")).toContain("\x1b[1;1Halpha");
    expect(chunks.join("")).toContain("\x1b[2;1Hbeta");
    expect(chunks.join("")).toContain("\x1b[?2026l");

    chunks.length = 0;
    const second = renderer.render(["alpha", "gamma"], { cursor: { row: 2, col: 6 } });
    const output = chunks.join("");
    expect(second).toMatchObject({ changedRows: 1, totalRows: 2, fullRepaint: false });
    expect(output).not.toContain("\x1b[1;1Halpha");
    expect(output).toContain("\x1b[2;1Hgamma");
    expect(output).toContain("\x1b[2;6H");
  });

  it("logs slow frames only when debug timing is enabled", () => {
    const debug: string[] = [];
    const times = [0, 50];
    const renderer = new FrameRenderer({
      stdout: { isTTY: false, write() { return true; } } as any,
      stderr: { write(chunk: string | Uint8Array) { debug.push(String(chunk)); return true; } } as any,
      env: { SEEKCODE_TUI_DEBUG: "1", SEEKCODE_TUI_SLOW_FRAME_MS: "10" } as any,
      now: () => times.shift() ?? 50,
      synchronizedOutput: false,
    });

    renderer.render(["alpha"], { cursor: { row: 1, col: 1 } });
    expect(debug.join("")).toContain("slow frame 50.0ms");
  });

  it("diffs anchored frames for inline dynamic regions", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    const stats = renderer.renderAnchored(["one", "two"], {
      previousFrame: ["one", "old", "stale"],
      cursor: { row: 2, col: 2 },
    });
    const output = chunks.join("");

    expect(stats).toMatchObject({ changedRows: 2, totalRows: 3, fullRepaint: false });
    expect(output).not.toContain("one");
    expect(output).toContain("two");
    expect(output).toContain("\x1b[2K");
    expect(output).toContain("\x1b[1A");
    expect(output).toContain("\x1b[1C");
  });

  it("detects synchronized output support from env and tty", () => {
    expect(shouldUseSynchronizedOutput({ SEEKCODE_TUI_SYNC_OUTPUT: "1" } as any, { isTTY: false } as any)).toBe(true);
    expect(shouldUseSynchronizedOutput({ SEEKCODE_TUI_SYNC_OUTPUT: "0" } as any, { isTTY: true } as any)).toBe(false);
    expect(shouldUseSynchronizedOutput({ TERM: "dumb" } as any, { isTTY: true } as any)).toBe(false);
  });

  it("falls back to SEEKCODE_SYNC_OUTPUT when the TUI-specific env var is unset", () => {
    expect(shouldUseSynchronizedOutput({ SEEKCODE_SYNC_OUTPUT: "yes" } as any, { isTTY: false } as any)).toBe(true);
  });

  it("forces a full repaint after renderer reset even for the same frame", () => {
    const chunks: string[] = [];
    const renderer = new FrameRenderer({
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
      } as any,
      synchronizedOutput: false,
    });

    renderer.render(["alpha"], { cursor: { row: 1, col: 1 } });
    renderer.reset();
    chunks.length = 0;
    const stats = renderer.render(["alpha"], { cursor: { row: 1, col: 1 } });

    expect(stats).toMatchObject({ changedRows: 1, fullRepaint: true });
    expect(chunks.join("")).toContain("\x1b[1;1Halpha");
  });
});

describe("TuiLayout", () => {
  it("places the footer directly after short transcript content", () => {
    const transcript = new Transcript();
    transcript.append("hello");
    const layout = new TuiLayout(transcript);

    expect(layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 20, 80)).toBe(1);
  });

  it("keeps cursor on screen for wrapped input", () => {
    const layout = new TuiLayout(new Transcript());
    const inputAreaBottomRow = 5;
    const cursor = layout.cursorPosition("● ", "12345678901234567890", 20, 10, inputAreaBottomRow);

    expect(cursor.row).toBeGreaterThanOrEqual(1);
    expect(cursor.row).toBeLessThanOrEqual(inputAreaBottomRow);
    expect(cursor.col).toBeGreaterThanOrEqual(1);
    expect(cursor.col).toBeLessThanOrEqual(10);
  });

  it("keeps the cursor column inside narrow terminal bounds when wrapping exactly at the edge", () => {
    const layout = new TuiLayout(new Transcript());
    const cursor = layout.cursorPosition("● ", "12345678", 8, 5, 4);

    expect(cursor.row).toBeGreaterThanOrEqual(1);
    expect(cursor.row).toBeLessThanOrEqual(4);
    expect(cursor.col).toBeGreaterThanOrEqual(1);
    expect(cursor.col).toBeLessThanOrEqual(5);
  });

  it("returns zero visible transcript rows when footer, status, completions, and input consume the viewport", () => {
    const transcript = new Transcript();
    transcript.append("hello");
    const layout = new TuiLayout(transcript);

    expect(layout.visibleTranscriptRows({
      footer: "─\nstatus",
      prompt: "● ",
      input: "line1\nline2\nline3",
      statusLine: "thinking",
      completions: ["a", "b", "c"],
      completionLimit: 3,
    }, 6, 20)).toBe(0);
  });

  it("places cursor on the last visible row for multiline input", () => {
    const layout = new TuiLayout(new Transcript());
    const cursor = layout.cursorPosition("● ", "alpha\nbeta", "alpha\nbeta".length, 20, 5);

    expect(cursor.row).toBe(5);
    expect(cursor.col).toBe(7);
  });

  it("keeps the cursor on the correct visible row when editing earlier multiline input", () => {
    const layout = new TuiLayout(new Transcript());
    const input = "one\ntwo\nthree\nfour";
    const cursorIndex = input.indexOf("two") + "two".length;
    const cursor = layout.cursorPosition("● ", input, cursorIndex, 20, 5);

    expect(cursor.row).toBe(4);
    expect(cursor.col).toBe(6);
    expect(layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input, cursor: cursorIndex }, 8, 20)).toBe(0);
  });

  it("honors explicit completion limits for pickers", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    const layout = new TuiLayout(transcript);
    const completions = Array.from({ length: 12 }, (_, index) => `item ${index}`);

    expect(layout.visibleTranscriptRows({
      footer: "─\nstatus",
      prompt: "● ",
      input: "",
      completions,
      completionLimit: completions.length,
    }, 24, 80)).toBe(9);
  });

  it("reserves a fixed status row above the input", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    const layout = new TuiLayout(transcript);
    const withoutStatus = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 12, 80);
    const withStatus = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "", statusLine: thinkingStatusLine(1250, true) }, 12, 80);

    expect(withStatus).toBe(withoutStatus - 1);
  });

  it("renders the fixed status row directly above the input row", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 10;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nfooter", prompt: "● ", input: "/tasks", statusLine: thinkingStatusLine(1250, true) });
      const output = stripAnsi(chunks.join(""));

      expect(output.indexOf("Thinking 1s · esc to interrupt")).toBeLessThan(output.indexOf("● /tasks"));
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("renders fullscreen through a frame diff instead of repainting unchanged rows", () => {
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 24;
    process.stdout.rows = 8;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const renderer = new FrameRenderer({
        stdout: {
          isTTY: false,
          write(chunk: string | Uint8Array) { chunks.push(String(chunk)); return true; },
        } as any,
        synchronizedOutput: false,
      });
      const layout = new TuiLayout(transcript, "fullscreen", renderer);

      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      expect(renderer.lastStats?.changedRows).toBe(8);
      expect(chunks.join("")).toContain("hello");

      chunks.length = 0;
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      expect(renderer.lastStats?.changedRows).toBe(0);
      expect(chunks.join("")).not.toContain("hello");

      transcript.appendDelta(" world");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      expect(renderer.lastStats?.changedRows).toBeGreaterThan(0);
      expect(chunks.join("")).toContain("hello world");
    } finally {
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("recomputes transcript height when the terminal grows", () => {
    const transcript = new Transcript();
    transcript.append(Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"));
    const layout = new TuiLayout(transcript);
    const narrow = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 12, 80);
    const tall = layout.visibleTranscriptRows({ footer: "─\nstatus", prompt: "● ", input: "" }, 30, 80);

    expect(tall).toBeGreaterThan(narrow);
  });

  it("can expose wrapped transcript rows for inline scrollback", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    expect(transcript.wrappedRows(3).map(stripAnsi)).toEqual(["abc", "def"]);
  });

  it("moves inline cursor below the rendered TUI on finish", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 10;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      layout.finish();

      expect(chunks.join("")).toContain("\r\n");
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("updates inline renders without clearing the whole dynamic region", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 10;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      const layout = new TuiLayout(transcript, "inline");
      transcript.append("hello");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      chunks.length = 0;
      transcript.appendDelta(" world");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });

      const output = chunks.join("");
      expect(output).not.toContain("\x1b[J");
      expect(output).toContain("\x1b[2K");
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("clears stale inline rows when completions shrink", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 12;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "/l", completions: ["  /load", "  /list", "  /logs"], completionLimit: 3 });
      chunks.length = 0;
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "", completions: [], completionLimit: 0 });

      const output = chunks.join("");
      expect(output).not.toContain("\x1b[J");
      expect(output.match(/\x1b\[2K/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });

  it("repaints inline layout from the previous top after resize", () => {
    const originalWrite = process.stdout.write;
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    const chunks: string[] = [];
    process.stdout.columns = 40;
    process.stdout.rows = 12;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const transcript = new Transcript();
      transcript.append("hello");
      const layout = new TuiLayout(transcript, "inline");
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });
      chunks.length = 0;
      process.stdout.columns = 24;
      layout.render({ footer: "─\nstatus", prompt: "● ", input: "" });

      const output = chunks.join("");
      expect(output).toContain("\x1b[2A");
      expect(output).not.toContain("\x1b[J");
    } finally {
      process.stdout.write = originalWrite;
      process.stdout.columns = originalColumns;
      process.stdout.rows = originalRows;
    }
  });
});

describe("ActiveToolLines", () => {
  it("tracks active tool lines by tool call id", () => {
    const lines = new ActiveToolLines();
    lines.start("call-1", 3);
    lines.start("call-2", 7);
    lines.start("call-3", 9);

    expect(lines.current("call-2")).toBe(7);
    expect(lines.finish("call-1")).toBe(3);
    expect(lines.finish("call-1")).toBeUndefined();
    expect(lines.finish("call-3")).toBe(9);
  });
});
