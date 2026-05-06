/** Structured modal requests rendered by the TUI input layer. */

import { p } from "../ui/palette.js";
import { pickerWindow, type PickItem } from "../ui/picker.js";
import * as r from "../ui/renderer.js";

export type TuiModalKind = "picker" | "approval" | "confirm";

export interface TuiModalState {
  kind: TuiModalKind;
  lines: string[];
}

export function pickerModalLines(
  idx: number,
  items: PickItem[],
  title: string,
  maxVisibleItems = 12,
): string[] {
  const window = pickerWindow(items, idx, maxVisibleItems);
  const lines: string[] = [];
  if (window.start > 0) {
    lines.push(p.dim(`  ↑ ${window.start} newer session${window.start === 1 ? "" : "s"}`));
  }
  for (const entry of window.entries) {
    const item = entry.item;
    const prefix = entry.selected ? p.blue("❯ ") : "  ";
    lines.push(item.desc ? `${prefix}${item.name}  ${p.dim(item.desc)}` : `${prefix}${item.name}`);
  }
  if (window.end < window.total) {
    lines.push(p.dim(`  ↓ ${window.total - window.end} older session${window.total - window.end === 1 ? "" : "s"}`));
  }
  lines.push(p.dim(`${title}  ↑↓ select  Enter confirm  Esc cancel`));
  return lines;
}

export function approvalModalLines(toolName: string, args: Record<string, unknown>): string[] {
  return r.approvalPrompt(toolName, args).split("\n");
}
