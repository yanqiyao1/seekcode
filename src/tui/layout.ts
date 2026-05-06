/** Full-screen TUI layout controller. */

import { fitAnsi, visibleLength, wrapAnsiLine } from "../ui/ansi.js";
import * as screen from "./screen.js";
import { FrameRenderer } from "./frame-renderer.js";
import { Transcript } from "./transcript.js";

export interface LayoutRenderOptions {
  footer: string;
  prompt: string;
  statusLine?: string;
  input?: string;
  cursor?: number;
  completions?: string[];
  completionLimit?: number;
  freezeHistory?: boolean;
}

export type TuiLayoutMode = "fullscreen" | "inline";

export class TuiLayout {
  private committedInlineRows = 0;
  private lastInlineRows = 0;
  private lastInlineCursorRow = 1;
  private lastInlineWidth = 0;
  private lastInlineRenderedRows: string[] = [];

  constructor(
    readonly transcript: Transcript,
    readonly mode: TuiLayoutMode = "fullscreen",
    private readonly frameRenderer = new FrameRenderer(),
  ) {}

  visibleTranscriptRows(options: LayoutRenderOptions, rows: number, cols: number): number {
    const size = { rows: Math.max(6, rows), cols: Math.max(20, cols) };
    const completionLines = (options.completions ?? []).slice(0, this.completionLimit(options, size.rows));
    const inputLines = this.inputLines(options.prompt, options.input ?? "", size.cols);
    const statusRows = options.statusLine ? 1 : 0;
    const reservedRows = 2 + statusRows + completionLines.length + inputLines.length;
    const maxTranscriptRows = Math.max(0, size.rows - reservedRows);
    return Math.min(this.transcript.desiredHeight(size.cols), maxTranscriptRows);
  }

  render(options: LayoutRenderOptions): void {
    if (this.mode === "inline") {
      this.renderInline(options);
      return;
    }
    this.renderFullscreen(options);
  }

  reset(): void {
    this.committedInlineRows = 0;
    this.lastInlineRows = 0;
    this.lastInlineCursorRow = 1;
    this.lastInlineWidth = 0;
    this.lastInlineRenderedRows = [];
    this.frameRenderer.reset();
  }

  finish(): void {
    if (this.mode !== "inline" || this.lastInlineRows <= 0) return;
    process.stdout.write("\r");
    const rowsBelowCursor = Math.max(0, this.lastInlineRows - this.lastInlineCursorRow);
    if (rowsBelowCursor > 0) process.stdout.write(`\x1b[${rowsBelowCursor}B`);
    process.stdout.write("\r\n");
    this.lastInlineRows = 0;
    this.lastInlineCursorRow = 1;
  }

  private renderFullscreen(options: LayoutRenderOptions): void {
    const rawSize = screen.termSize();
    const size = { rows: Math.max(6, rawSize.rows), cols: Math.max(20, rawSize.cols) };
    const [dividerLine = "", statusLine = ""] = options.footer.split("\n").slice(0, 2);

    const completionLines = (options.completions ?? []).slice(0, this.completionLimit(options, size.rows));
    const inputLines = this.inputLines(options.prompt, options.input ?? "", size.cols);
    const transcriptRows = this.visibleTranscriptRows(options, size.rows, size.cols);
    const fixedStatusLine = options.statusLine ? fitAnsi(options.statusLine, size.cols) : null;

    const frame: string[] = [];
    if (transcriptRows > 0) frame.push(...this.transcript.render(transcriptRows, size.cols).split("\n"));
    frame.push(fitAnsi(dividerLine, size.cols));
    frame.push(...completionLines.map(line => fitAnsi(line, size.cols)));
    if (fixedStatusLine) frame.push(fixedStatusLine);
    frame.push(...inputLines.map(line => fitAnsi(line, size.cols)));
    const inputBottomRow = frame.length;
    frame.push(fitAnsi(statusLine, size.cols));
    while (frame.length < size.rows) frame.push(" ".repeat(size.cols));
    if (frame.length > size.rows) frame.length = size.rows;

    const cursor = this.cursorPosition(
      options.prompt,
      options.input ?? "",
      options.cursor ?? 0,
      size.cols,
      inputBottomRow,
    );
    this.frameRenderer.render(frame, { cursor, cols: size.cols });
  }

  private renderInline(options: LayoutRenderOptions): void {
    const rawSize = screen.termSize();
    const size = { rows: Math.max(6, rawSize.rows), cols: Math.max(20, rawSize.cols) };
    const [dividerLine = "", statusLine = ""] = options.footer.split("\n").slice(0, 2);

    if (this.lastInlineWidth && this.lastInlineWidth !== size.cols) {
      this.clearInlineRows();
      this.reset();
    }
    this.lastInlineWidth = size.cols;

    const completionLines = (options.completions ?? []).slice(0, this.completionLimit(options, size.rows));
    const inputLines = this.inputLines(options.prompt, options.input ?? "", size.cols);
    const transcriptRows = this.visibleTranscriptRows(options, size.rows, size.cols);
    const totalWrappedRows = this.transcript.desiredHeight(size.cols);
    const fixedStatusLine = options.statusLine ? fitAnsi(options.statusLine, size.cols) : null;
    const commitTarget = options.freezeHistory
      ? Math.min(this.committedInlineRows, totalWrappedRows)
      : Math.max(0, totalWrappedRows - transcriptRows);

    screen.hideCursor();
    if (this.lastInlineRows > 0) {
      process.stdout.write("\r");
      if (this.lastInlineCursorRow > 1) process.stdout.write(`\x1b[${this.lastInlineCursorRow - 1}A`);
    }

    const historyRows = commitTarget > this.committedInlineRows
      ? this.transcript.wrappedRowsRange(size.cols, this.committedInlineRows, commitTarget)
      : [];
    if (commitTarget > this.committedInlineRows) {
      if (historyRows.length) {
        for (const line of historyRows) {
          process.stdout.write(`\r\x1b[2K${fitAnsi(line, size.cols)}\n`);
        }
      }
      this.committedInlineRows = commitTarget;
    }

    const transcriptOutput = transcriptRows > 0 ? this.transcript.render(transcriptRows, size.cols).split("\n") : [];
    const rows = [
      ...transcriptOutput,
      fitAnsi(dividerLine, size.cols),
      ...completionLines.map(line => fitAnsi(line, size.cols)),
      ...(fixedStatusLine ? [fixedStatusLine] : []),
      ...inputLines.map(line => fitAnsi(line, size.cols)),
      fitAnsi(statusLine, size.cols),
    ];

    const previousRows = historyRows.length
      ? this.lastInlineRenderedRows.slice(historyRows.length)
      : this.lastInlineRenderedRows;

    const inputBottomRow = transcriptOutput.length + 1 + completionLines.length + (fixedStatusLine ? 1 : 0) + inputLines.length;
    const cursor = this.cursorPosition(
      options.prompt,
      options.input ?? "",
      options.cursor ?? 0,
      size.cols,
      inputBottomRow,
    );
    this.frameRenderer.renderAnchored(rows, {
      previousFrame: previousRows,
      cursor,
    });

    this.lastInlineRows = rows.length;
    this.lastInlineCursorRow = cursor.row;
    this.lastInlineRenderedRows = rows;
  }

  private clearInlineRows(): void {
    if (this.lastInlineRows <= 0) return;
    process.stdout.write("\r");
    if (this.lastInlineCursorRow > 1) process.stdout.write(`\x1b[${this.lastInlineCursorRow - 1}A`);
    for (let i = 0; i < this.lastInlineRows; i++) {
      process.stdout.write("\r\x1b[2K");
      if (i < this.lastInlineRows - 1) process.stdout.write("\n");
    }
    process.stdout.write("\r");
    if (this.lastInlineRows > 1) process.stdout.write(`\x1b[${this.lastInlineRows - 1}A`);
  }

  private inputLines(prompt: string, input: string, cols: number): string[] {
    const rows: string[] = [];
    const logicalLines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let index = 0; index < logicalLines.length; index++) {
      const prefix = index === 0 ? prompt : " ".repeat(visibleLength(prompt));
      rows.push(...wrapAnsiLine(prefix + logicalLines[index], cols));
    }
    return rows.slice(-3);
  }

  cursorPosition(prompt: string, input: string, cursor: number, cols: number, rows: number): { row: number; col: number } {
    const beforeCursor = input.slice(0, cursor).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const logicalBeforeCursor = beforeCursor.split("\n");
    let promptInputRows = 0;
    for (let index = 0; index < logicalBeforeCursor.length; index++) {
      const prefix = index === 0 ? prompt : " ".repeat(visibleLength(prompt));
      promptInputRows += wrapAnsiLine(prefix + logicalBeforeCursor[index], cols).length;
    }

    const promptWidth = visibleLength(prompt);
    const currentLogicalLine = logicalBeforeCursor.at(-1) ?? "";
    const width = promptWidth + visibleLength(currentLogicalLine);
    const visibleRows = Math.min(3, Math.max(1, promptInputRows));
    const row = rows - visibleRows + Math.min(visibleRows, Math.max(1, promptInputRows));
    const col = (width % cols) + 1;
    return { row, col };
  }

  private maxCompletions(rows: number): number {
    return Math.max(0, Math.min(8, rows - 8));
  }

  private completionLimit(options: LayoutRenderOptions, rows: number): number {
    if (options.completionLimit === undefined) return this.maxCompletions(rows);
    return Math.max(0, Math.min(Math.floor(options.completionLimit), rows - 3));
  }
}
