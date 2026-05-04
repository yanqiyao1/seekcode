/** Raw-mode input with Tab completion. No cursor tricks — just clear and redraw. */

import { p } from "./palette.js";
import { visibleLength } from "./ansi.js";

export const COMMANDS: [string, string][] = [
  ["help", "Show help"], ["plan", "Plan mode"], ["agent", "Agent mode"],
  ["yolo", "YOLO mode"], ["provider", "Switch provider"], ["model", "Switch model"], ["reasoning", "Cycle effort"],
  ["capabilities", "Model capability matrix"], ["jobs", "Background jobs"],
  ["clear", "Clear history"], ["save", "Save session"], ["load", "Load session"],
  ["delete", "Delete session"], ["sessions", "List sessions"], ["exit", "Save & exit"], ["restore", "Snapshots"],
  ["cost", "Cost breakdown"], ["tokens", "Token usage"], ["tasks", "Tasks"],
  ["skills", "Skills"], ["skill", "Apply/manage skill"], ["permissions", "Permissions"], ["version", "Version"],
];

export type InputResult = { type: "line"; value: string } | { type: "interrupt" } | { type: "eof" };

const SHIFT_TAB_SEQUENCES = new Set(["\x1b[Z", "\x1b[1;2Z"]);

export function isShiftTabSequence(sequence: string): boolean {
  return SHIFT_TAB_SEQUENCES.has(sequence);
}

function matches(prefix: string): [string, string][] {
  if (!prefix.startsWith("/")) return [];
  const p = prefix.slice(1).toLowerCase();
  if (!p) return COMMANDS;
  return COMMANDS.filter(([n]) => n.startsWith(p));
}

function commonPrefix(strings: string[]): string {
  if (!strings.length) return "";
  let pre = strings[0];
  for (const s of strings.slice(1)) { while (!s.startsWith(pre)) pre = pre.slice(0, -1); }
  return pre;
}

export interface ReadInputOptions {
  onInterrupt?: () => void;
  onModeCycle?: () => string | void;
  onScroll?: (direction: "up" | "down" | "top" | "bottom", amount: number) => void;
  onRender?: (state: { prompt: string; value: string; cursor: number; completions: string[] }) => void;
}

export type ScrollDirection = "up" | "down" | "top" | "bottom";

export function previousGraphemeIndex(text: string, index: number): number {
  const before = Array.from(text.slice(0, Math.max(0, index)));
  before.pop();
  return before.join("").length;
}

export function nextGraphemeIndex(text: string, index: number): number {
  const next = Array.from(text.slice(Math.max(0, index)))[0];
  return next ? index + next.length : index;
}

export function restoreTTYInput(
  stdin: Pick<NodeJS.ReadStream, "setRawMode" | "pause">,
  wasRaw: boolean | undefined,
  pauseInput = true,
): void {
  stdin.setRawMode?.(!!wasRaw);
  if (pauseInput) stdin.pause();
}

export function scrollActionForSequence(sequence: string): { direction: ScrollDirection; amount: number } | null {
  if (/^\x1b\[5(?:;\d+)?~$/.test(sequence)) return { direction: "up", amount: 8 };
  if (/^\x1b\[6(?:;\d+)?~$/.test(sequence)) return { direction: "down", amount: 8 };
  if (sequence === "\x1b[1;5H" || sequence === "\x1b[5;5~") return { direction: "top", amount: Number.POSITIVE_INFINITY };
  if (sequence === "\x1b[1;5F" || sequence === "\x1b[6;5~") return { direction: "bottom", amount: Number.POSITIVE_INFINITY };
  if (/^\x1b\[1;[25]A$/.test(sequence)) return { direction: "up", amount: 3 };
  if (/^\x1b\[1;[25]B$/.test(sequence)) return { direction: "down", amount: 3 };
  if (/^\x1b\[<64;\d+;\d+[mM]$/.test(sequence)) return { direction: "up", amount: 3 };
  if (/^\x1b\[<65;\d+;\d+[mM]$/.test(sequence)) return { direction: "down", amount: 3 };
  return null;
}

export function splitInputSequences(chunk: string): string[] {
  const sequences: string[] = [];
  for (let index = 0; index < chunk.length;) {
    if (chunk[index] !== "\x1b") {
      const nextEscape = chunk.indexOf("\x1b", index);
      const end = nextEscape === -1 ? chunk.length : nextEscape;
      sequences.push(...Array.from(chunk.slice(index, end)));
      index = end;
      continue;
    }

    if (chunk.startsWith("\x1b[<", index)) {
      const match = /^\x1b\[<\d+;\d+;\d+[mM]/.exec(chunk.slice(index));
      if (match) {
        sequences.push(match[0]);
        index += match[0].length;
        continue;
      }
    }

    const csiMatch = /^\x1b\[[0-9;?]*[~A-Za-z]/.exec(chunk.slice(index));
    if (csiMatch) {
      sequences.push(csiMatch[0]);
      index += csiMatch[0].length;
      continue;
    }

    const ss3Match = /^\x1bO[A-Za-z]/.exec(chunk.slice(index));
    if (ss3Match) {
      sequences.push(ss3Match[0]);
      index += ss3Match[0].length;
      continue;
    }

    sequences.push("\x1b");
    index += 1;
  }
  return sequences;
}

export function trailingIncompleteEscapeStart(chunk: string): number {
  const lastEscape = chunk.lastIndexOf("\x1b");
  if (lastEscape < 0) return -1;
  const tail = chunk.slice(lastEscape);
  if (tail === "\x1b") return lastEscape;
  if (tail === "\x1b[") return lastEscape;
  if (tail === "\x1b[<") return lastEscape;
  if (/^\x1b\[(?:<)?[0-9;?]+$/.test(tail)) return lastEscape;
  if (tail === "\x1bO") return lastEscape;
  return -1;
}

export async function readInput(
  prompt: string,
  opts?: ReadInputOptions,
): Promise<InputResult> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    return new Promise(r => rl.question("", (l) => { rl.close(); r({ type: "line", value: l }); }));
  }

  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();

  let buf = "", pos = 0, showComps = false;
  let currentPrompt = prompt;
  let pendingEscape = "";
  let pendingEscapeTimer: NodeJS.Timeout | null = null;

  const formatCompletions = (comps: [string, string][]): string[] => comps.slice(0, 9).map(([name, desc]) => {
    const partial = buf.slice(1).toLowerCase();
    const hl = partial
      ? p.blue(name.slice(0, partial.length)) + p.text(name.slice(partial.length))
      : p.text(name);
    return `  /${hl}  ${p.dim(desc)}`;
  });

  function redraw(comps?: [string, string][]) {
    if (opts?.onRender) {
      opts.onRender({ prompt: currentPrompt, value: buf, cursor: pos, completions: comps?.length ? formatCompletions(comps) : [] });
      showComps = !!comps?.length;
      return;
    }

    // Move to start of input line, clear it
    stdout.write("\r\x1b[2K" + currentPrompt + buf);
    // Position cursor within buf
    if (pos < buf.length) stdout.write(`\x1b[${pos - buf.length}D`);

    // Show completions below
    if (comps?.length) {
      stdout.write("\n");
      for (const line of formatCompletions(comps)) stdout.write(`\x1b[2K${line}\n`);
      if (comps.length > 9) stdout.write(`\x1b[2K  ${p.dim(`... and ${comps.length - 9} more`)}\n`);
      // Move back up to input line
      const rows = Math.min(comps.length, 9) + (comps.length > 9 ? 1 : 0);
      stdout.write(`\x1b[${rows}A\x1b[${visibleLength(currentPrompt) + pos}C`);
      showComps = true;
    } else if (showComps) {
      // Clear previous completions
      stdout.write("\n\x1b[J\x1b[1A");
      showComps = false;
    }
  }

  if (opts?.onRender) redraw();
  else stdout.write("\n" + currentPrompt);

  return new Promise((resolve) => {
    let cleaned = false;
    let settled = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (pendingEscapeTimer) clearTimeout(pendingEscapeTimer);
      if (!opts?.onRender && showComps) { stdout.write("\n\x1b[J"); showComps = false; }
      stdin.removeListener("data", onData);
      restoreTTYInput(stdin, wasRaw);
    };

    const finish = (result: InputResult) => {
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleKey = (s: string) => {
      if (settled) return;

      if (isShiftTabSequence(s)) {
        const nextPrompt = opts?.onModeCycle?.();
        if (typeof nextPrompt === "string") currentPrompt = nextPrompt;
        redraw();
        return;
      }

      const scrollAction = scrollActionForSequence(s);
      if (scrollAction) {
        opts?.onScroll?.(scrollAction.direction, scrollAction.amount);
        redraw();
        return;
      }

      // Escape sequences (arrows)
      if (s.startsWith("\x1b") && s.length > 1) {
        if (s === "\x1b[A" || s === "\x1bOA") return; // up — ignore
        if (s === "\x1b[B" || s === "\x1bOB") return; // down — ignore
        if (s === "\x1b[D" || s === "\x1bOD") { if (pos > 0) pos = previousGraphemeIndex(buf, pos); redraw(); return; }
        if (s === "\x1b[C" || s === "\x1bOC") { if (pos < buf.length) pos = nextGraphemeIndex(buf, pos); redraw(); return; }
        if (s === "\x1b[H" || s === "\x1bOH") { pos = 0; redraw(); return; }
        if (s === "\x1b[F" || s === "\x1bOF") { pos = buf.length; redraw(); return; }
        return;
      }

      // Lone Esc
      if (s === "\x1b") { opts?.onInterrupt?.(); return; }

      // Tab — complete
      if (s === "\t") {
        const m = matches(buf);
        if (m.length === 1) { buf = "/" + m[0][0] + " "; pos = buf.length; redraw(); }
        else if (m.length > 1) {
          const pre = "/" + commonPrefix(m.map(([n]) => n));
          if (pre.length > buf.length) { buf = pre; pos = buf.length; }
          redraw(m);
        }
        return;
      }

      // Enter
      if (s === "\r" || s === "\n") {
        if (!opts?.onRender) stdout.write("\n");
        finish({ type: "line", value: buf });
        return;
      }

      // Ctrl+D empty → EOF
      if (s === "\x04" && !buf) { if (!opts?.onRender) stdout.write("\n"); finish({ type: "eof" }); return; }
      // Ctrl+C → EOF
      if (s === "\x03") { if (!opts?.onRender) stdout.write("\n"); finish({ type: "eof" }); return; }

      // Backspace
      if (s === "\x7f" || s === "\x08") {
        if (pos > 0) {
          const previous = previousGraphemeIndex(buf, pos);
          buf = buf.slice(0, previous) + buf.slice(pos);
          pos = previous;
          redraw();
        }
        return;
      }

      // Home / End
      if (s === "\x01") { pos = 0; redraw(); return; }
      if (s === "\x05") { pos = buf.length; redraw(); return; }

      // Printable
      const codePoint = s.codePointAt(0) ?? 0;
      if (Array.from(s).length === 1 && codePoint >= 32 && codePoint !== 0x7f) {
        buf = buf.slice(0, pos) + s + buf.slice(pos); pos = nextGraphemeIndex(buf, pos);
        if (buf.startsWith("/")) redraw(matches(buf));
        else redraw();
        return;
      }
    };

    const onData = (data: Buffer) => {
      if (pendingEscapeTimer) {
        clearTimeout(pendingEscapeTimer);
        pendingEscapeTimer = null;
      }
      const s = pendingEscape + data.toString();
      pendingEscape = "";
      const incompleteEscapeStart = trailingIncompleteEscapeStart(s);
      if (incompleteEscapeStart >= 0) {
        const complete = s.slice(0, incompleteEscapeStart);
        pendingEscape = s.slice(incompleteEscapeStart);
        for (const key of splitInputSequences(complete)) handleKey(key);
        pendingEscapeTimer = setTimeout(() => {
          const pending = pendingEscape;
          pendingEscape = "";
          pendingEscapeTimer = null;
          for (const key of splitInputSequences(pending)) handleKey(key);
        }, 25);
        return;
      }
      for (const key of splitInputSequences(s)) handleKey(key);
    };

    stdin.on("data", onData);
  });
}
