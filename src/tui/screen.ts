/** Terminal screen management — alternate buffer, layout, rendering. */

const CSI = "\x1b[";
let activeAlternateScreen = false;

export function enterAltScreen(): void {
  process.stdout.write(`${CSI}?1049h${CSI}H${CSI}J`);
}

export function leaveAltScreen(): void {
  process.stdout.write(`${CSI}?1049l`);
}

export function hideCursor(): void {
  process.stdout.write(`${CSI}?25l`);
}

export function showCursor(): void {
  process.stdout.write(`${CSI}?25h`);
}

export function clearScreen(): void {
  process.stdout.write(`${CSI}H${CSI}J`);
}

export function enableMouse(): void {
  process.stdout.write(`${CSI}?1000h${CSI}?1006h`);
}

export function disableMouse(): void {
  process.stdout.write(`${CSI}?1006l${CSI}?1000l`);
}

export function enableBracketedPaste(): void {
  process.stdout.write(`${CSI}?2004h`);
}

export function disableBracketedPaste(): void {
  process.stdout.write(`${CSI}?2004l`);
}

export function moveTo(row: number, col: number): void {
  process.stdout.write(`${CSI}${row};${col}H`);
}

export function termSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

export function setup(options: { alternateScreen?: boolean } = {}) {
  const useAlternateScreen = options.alternateScreen !== false;
  if (useAlternateScreen && !activeAlternateScreen) {
    enterAltScreen();
  }
  if (!useAlternateScreen && activeAlternateScreen) {
    // Preserve the active alternate-screen state until teardown restores it.
  }
  activeAlternateScreen = activeAlternateScreen || useAlternateScreen;
  hideCursor();
}

export function teardown(options: { finalNewline?: boolean } = {}) {
  showCursor();
  if (activeAlternateScreen) {
    leaveAltScreen();
  } else {
    process.stdout.write(`${CSI}0m${options.finalNewline === false ? "" : "\r\n"}`);
  }
  activeAlternateScreen = false;
}
