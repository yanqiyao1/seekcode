/** Fullscreen terminal frame renderer with line diffing and optional synchronized output. */

const CSI = "\x1b[";
const SYNC_START = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;

export interface FrameRenderCursor {
  row: number;
  col: number;
}

export interface FrameRenderStats {
  changedRows: number;
  totalRows: number;
  durationMs: number;
  fullRepaint: boolean;
}

export interface FrameRendererOptions {
  stdout?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  synchronizedOutput?: boolean;
  debug?: boolean;
  slowFrameMs?: number;
}

export interface FrameRenderOptions {
  cursor: FrameRenderCursor;
  force?: boolean;
  cols?: number;
}

export interface AnchoredFrameRenderOptions {
  previousFrame: string[];
  cursor: FrameRenderCursor;
  force?: boolean;
}

export function shouldUseSynchronizedOutput(
  env: NodeJS.ProcessEnv = process.env,
  stdout: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
): boolean {
  const configured = env.SEEKCODE_TUI_SYNC_OUTPUT ?? env.SEEKCODE_SYNC_OUTPUT;
  if (configured !== undefined) return /^(1|true|yes|on)$/i.test(configured);
  return stdout.isTTY === true && env.TERM !== "dumb";
}

export class FrameRenderer {
  private previousFrame: string[] = [];
  private previousRows = 0;
  private previousCols = 0;
  private readonly stdout: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  private readonly stderr: Pick<NodeJS.WriteStream, "write">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  lastStats: FrameRenderStats | null = null;

  constructor(private readonly options: FrameRendererOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => performance.now());
  }

  reset(): void {
    this.previousFrame = [];
    this.previousRows = 0;
    this.previousCols = 0;
    this.lastStats = null;
  }

  render(frame: string[], options: FrameRenderOptions): FrameRenderStats {
    const startedAt = this.now();
    const totalRows = frame.length;
    const cols = options.cols ?? frame[0]?.length ?? 0;
    const fullRepaint = options.force === true
      || this.previousRows !== totalRows
      || this.previousCols !== cols;
    const chunks: string[] = [];
    let changedRows = 0;

    chunks.push(`${CSI}?25l`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_START);

    for (let index = 0; index < totalRows; index++) {
      const next = frame[index] ?? "";
      const previous = fullRepaint ? undefined : this.previousFrame[index];
      if (next === previous) continue;
      changedRows++;
      chunks.push(`${CSI}${index + 1};1H${next}`);
    }

    chunks.push(`${CSI}${options.cursor.row};${options.cursor.col}H`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_END);
    chunks.push(`${CSI}?25h`);

    this.write(chunks);
    this.previousFrame = [...frame];
    this.previousRows = totalRows;
    this.previousCols = cols;

    const stats = this.recordStats({
      changedRows,
      totalRows,
      fullRepaint,
    }, startedAt);
    return stats;
  }

  renderAnchored(frame: string[], options: AnchoredFrameRenderOptions): FrameRenderStats {
    const startedAt = this.now();
    const rowsToPaint = Math.max(frame.length, options.previousFrame.length);
    const fullRepaint = options.force === true;
    const chunks: string[] = [];
    let changedRows = 0;

    chunks.push(`${CSI}?25l`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_START);

    for (let index = 0; index < rowsToPaint; index++) {
      const next = frame[index] ?? "";
      const previous = fullRepaint ? undefined : options.previousFrame[index];
      if (next !== previous) {
        changedRows++;
        chunks.push(`\r${CSI}2K${next}`);
      }
      if (index < rowsToPaint - 1) chunks.push("\r\n");
    }

    const rowsAfterCursor = Math.max(0, rowsToPaint - options.cursor.row);
    chunks.push("\r");
    if (rowsAfterCursor > 0) chunks.push(`${CSI}${rowsAfterCursor}A`);
    if (options.cursor.col > 1) chunks.push(`${CSI}${options.cursor.col - 1}C`);
    if (this.useSynchronizedOutput()) chunks.push(SYNC_END);
    chunks.push(`${CSI}?25h`);

    this.write(chunks);
    const stats = this.recordStats({
      changedRows,
      totalRows: rowsToPaint,
      fullRepaint,
    }, startedAt);
    return stats;
  }

  private useSynchronizedOutput(): boolean {
    if (this.options.synchronizedOutput !== undefined) return this.options.synchronizedOutput;
    return shouldUseSynchronizedOutput(this.env, this.stdout);
  }

  private logSlowFrame(stats: FrameRenderStats): void {
    const debug = this.options.debug ?? /^(1|true|yes|on)$/i.test(this.env.SEEKCODE_TUI_DEBUG ?? "");
    if (!debug) return;
    const slowFrameMs = this.options.slowFrameMs ?? Number.parseFloat(this.env.SEEKCODE_TUI_SLOW_FRAME_MS ?? "32");
    if (!Number.isFinite(slowFrameMs) || stats.durationMs <= slowFrameMs) return;
    this.stderr.write(`[seekcode:tui] slow frame ${stats.durationMs.toFixed(1)}ms, rows ${stats.changedRows}/${stats.totalRows}${stats.fullRepaint ? ", full repaint" : ""}\n`);
  }

  private write(chunks: string[]): void {
    this.stdout.write(chunks.join(""));
  }

  private recordStats(stats: Omit<FrameRenderStats, "durationMs">, startedAt: number): FrameRenderStats {
    const frameStats = {
      ...stats,
      durationMs: this.now() - startedAt,
    };
    this.lastStats = frameStats;
    this.logSlowFrame(frameStats);
    return frameStats;
  }
}
