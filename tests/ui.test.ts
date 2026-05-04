import { describe, expect, it } from "vitest";

import { nextModeName } from "../src/modes/base.js";
import { fitAnsi, stripAnsi, truncateAnsi, visibleLength, wrapAnsi } from "../src/ui/ansi.js";
import { COMMANDS, isShiftTabSequence, nextGraphemeIndex, previousGraphemeIndex, restoreTTYInput, scrollActionForSequence, splitInputSequences, trailingIncompleteEscapeStart } from "../src/ui/input.js";
import { renderMarkdown } from "../src/ui/markdown.js";
import { movePickerIndex, pickerActionForSequence, pickerWindow } from "../src/ui/picker.js";
import { footerDivider, statusBar, statusBarFromItems, thinkingHeader, thinkingStatusLine, thinkingText, toolDiffPreview, welcomeBanner } from "../src/ui/renderer.js";
import { AssistantStream } from "../src/tui/assistant-stream.js";
import { shouldUseAlternateScreen } from "../src/tui/alternate-screen.js";
import { TuiLayout } from "../src/tui/layout.js";
import { ActiveToolLines } from "../src/tui/tool-lines.js";
import { Transcript } from "../src/tui/transcript.js";

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

  it("renders short transcript from the top", () => {
    const transcript = new Transcript();
    transcript.append("abcdef");

    const rendered = transcript.render(2, 3).split("\n");
    expect(rendered).toHaveLength(2);
    expect(stripAnsi(rendered[0])).toBe("abc");
    expect(rendered.every(line => visibleLength(line) === 3)).toBe(true);
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

  it("retains more than ten thousand transcript lines", () => {
    const transcript = new Transcript();
    transcript.maxLines = 20_000;
    transcript.append(Array.from({ length: 12_000 }, (_, index) => `line ${index}`).join("\n"));

    expect(transcript.lines).toHaveLength(12_000);
    expect(transcript.lines[0].text).toBe("line 0");
    expect(transcript.lines.at(-1)?.text).toBe("line 11999");
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
});

describe("Markdown renderer", () => {
  it("renders common markdown constructs for terminal output", () => {
    const rendered = renderMarkdown([
      "# Title",
      "",
      "- **Bold** and `code`",
      "> quoted",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n"));

    const plain = stripAnsi(rendered).split("\n");
    expect(plain).toEqual([
      "Title",
      "",
      "• Bold and code",
      "│ quoted",
      "  │ ts",
      "  │ const x = 1;",
      "  │",
    ]);
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

  it("keeps the default footer focused without context budget or elapsed time", () => {
    const originalColumns = process.stdout.columns;
    process.stdout.columns = 120;
    try {
      const rendered = stripAnsi(statusBarFromItems([], {
        mode: "agent",
        model: "deepseek-v4-pro",
        workspace: "/ssd/yqy/projects/seek-code",
        tokens: 42_000,
        contextLimit: 1_000_000,
        elapsedMs: 12_000,
        keyHints: "esc to interrupt  Shift+Tab switch mode",
      }));

      expect(rendered).toContain("AGENT");
      expect(rendered).toContain("deepseek-v4-pro");
      expect(rendered).toContain("/ssd/yqy/projects/seek-code");
      expect(rendered).toContain("Shift+Tab switch mode");
      expect(rendered).not.toContain("ctx ");
      expect(rendered).not.toContain("elapsed ");
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
  it("tracks repeated tool names in FIFO order", () => {
    const lines = new ActiveToolLines();
    lines.start("read", 3);
    lines.start("read", 7);
    lines.start("write", 9);

    expect(lines.finish("read")).toBe(3);
    expect(lines.finish("read")).toBe(7);
    expect(lines.finish("read")).toBeUndefined();
    expect(lines.finish("write")).toBe(9);
  });
});
