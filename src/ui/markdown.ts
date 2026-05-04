/** Lightweight Markdown renderer for terminal transcript output. */

import { p, box } from "./palette.js";

type InlineSegment = { text: string; bold: boolean; code: boolean };

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rendered: string[] = [];
  let inFence = false;
  let fenceLang = "";

  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*```([\w.+-]*)\s*$/);
    if (fence) {
      inFence = !inFence;
      fenceLang = inFence ? fence[1] || "" : "";
      rendered.push(p.dim(`  ${box.v}${fenceLang ? ` ${fenceLang}` : ""}`));
      continue;
    }

    if (inFence) {
      rendered.push(`${p.dim(`  ${box.v} `)}${p.text(rawLine)}`);
      continue;
    }

    rendered.push(renderMarkdownLine(rawLine));
  }

  return rendered.join("\n");
}

function renderMarkdownLine(line: string): string {
  if (!line.trim()) return "";

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    return p.blueBold(heading[2].trim());
  }

  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return p.dim(`${box.v} ${renderInline(quote[1])}`);
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unordered) {
    return `${unordered[1]}${p.blue("•")} ${renderInline(unordered[2])}`;
  }

  const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
  if (ordered) {
    return `${ordered[1]}${p.blue("•")} ${renderInline(ordered[2])}`;
  }

  return renderInline(line);
}

function renderInline(text: string): string {
  return parseInline(text).map(segment => {
    if (segment.code) return p.warning(segment.text);
    if (segment.bold) return p.blueBold(segment.text);
    return p.text(segment.text);
  }).join("");
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        segments.push({ text: text.slice(index + 1, end), bold: false, code: true });
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        segments.push({ text: text.slice(index + 2, end), bold: true, code: false });
        index = end + 2;
        continue;
      }
    }

    const nextCode = text.indexOf("`", index + 1);
    const nextBold = text.indexOf("**", index + 1);
    const candidates = [nextCode, nextBold].filter(pos => pos >= 0);
    const next = candidates.length ? Math.min(...candidates) : text.length;
    segments.push({ text: text.slice(index, next), bold: false, code: false });
    index = next;
  }
  return segments;
}
