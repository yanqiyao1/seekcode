/** Scrollable transcript buffer for chat messages. */

import { fitAnsi, visibleLength, wrapAnsi } from "../ui/ansi.js";

export interface TranscriptLine {
  text: string;    // raw text (may contain ANSI)
  plainLen: number; // visible length
}

export class Transcript {
  lines: TranscriptLine[] = [];
  scrollOffset = 0; // 0 = bottom, positive = scroll up
  maxLines = 100000;
  private lastRenderWidth = 80;

  clear(): void {
    this.lines = [];
    this.scrollOffset = 0;
  }

  append(text: string): void {
    for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
      this.lines.push({
        text: raw,
        plainLen: visibleLength(raw),
      });
    }
    // Trim old lines
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.splice(this.lines.length - this.maxLines);
    }
  }

  appendFormatted(lines: string[]): void {
    for (const line of lines) {
      this.lines.push({ text: line, plainLen: visibleLength(line) });
    }
  }

  replaceLine(index: number, text: string): void {
    if (index < 0 || index >= this.lines.length) return;
    this.lines[index] = { text, plainLen: visibleLength(text) };
  }

  replaceRange(start: number, deleteCount: number, text: string): number {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
      .map(raw => ({ text: raw, plainLen: visibleLength(raw) }));
    this.lines.splice(Math.max(0, start), Math.max(0, deleteCount), ...lines);
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.splice(this.lines.length - this.maxLines);
    }
    return lines.length;
  }

  appendDelta(text: string): void {
    const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (!this.lines.length) this.lines.push({ text: "", plainLen: 0 });

    const appendToLast = (chunk: string) => {
      const last = this.lines[this.lines.length - 1];
      last.text += chunk;
      last.plainLen = visibleLength(last.text);
    };

    appendToLast(parts[0]);
    for (const part of parts.slice(1)) {
      this.lines.push({ text: part, plainLen: visibleLength(part) });
    }

    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.splice(this.lines.length - this.maxLines);
    }
  }

  /** Render visible portion into available height */
  render(height: number, width: number): string {
    if (height <= 0 || width <= 0) return "";
    this.lastRenderWidth = width;
    if (this.lines.length === 0) return Array.from({ length: height }, () => " ".repeat(width)).join("\n");

    const wrapped = this.wrappedLines(width);
    if (!wrapped.length) return Array.from({ length: height }, () => " ".repeat(width)).join("\n");

    const totalLines = wrapped.length;
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset(height, width));
    const visibleEnd = totalLines - this.scrollOffset;
    const visibleStart = Math.max(0, visibleEnd - height);

    const out: string[] = [];
    for (let i = visibleStart; i < visibleEnd; i++) {
      if (i >= 0 && i < wrapped.length) {
        out.push(fitAnsi(wrapped[i], width));
      }
    }

    while (out.length < height) out.push(" ".repeat(width));
    return out.join("\n");
  }

  desiredHeight(width: number): number {
    if (width <= 0 || !this.lines.length) return 0;
    return this.wrappedLines(width).length;
  }

  wrappedRows(width: number): string[] {
    return this.wrappedLines(width);
  }

  private wrappedLines(width: number): string[] {
    return this.lines.flatMap(line => wrapAnsi(line.text, width));
  }

  scrollUp(n: number): void {
    this.scrollOffset = Math.min(this.maxScrollOffset(undefined, this.lastRenderWidth), this.scrollOffset + Math.max(0, n));
  }

  scrollDown(n: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(0, n));
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  scrollToTop(): void {
    this.scrollOffset = this.maxScrollOffset(undefined, this.lastRenderWidth);
  }

  maxScrollOffset(height = 1, width = this.lastRenderWidth): number {
    return Math.max(0, this.desiredHeight(width) - Math.max(1, height));
  }
}
