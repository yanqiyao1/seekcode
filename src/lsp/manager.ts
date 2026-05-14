/** Lightweight LSP facade with local fallbacks.
 *
 * This gives Seek Code stable symbol/definition style tool APIs before a
 * long-lived JSON-RPC language-server backend is introduced.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePathAlias } from "../tools/path-resolution.js";

export interface DocumentSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  file: string;
  line: number;
  text: string;
}

export interface DefinitionMatch {
  file: string;
  line: number;
  text: string;
}

export class LspManager {
  documentSymbols(file: string, workdir = process.cwd()): DocumentSymbol[] {
    const path = resolvePathAlias(file, resolve(workdir));
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8");
    return extractSymbols(content, path);
  }

  definition(symbol: string, workdir = process.cwd()): DefinitionMatch[] {
    const query = symbol.trim();
    if (!query) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = `(function|class|interface|type|const|let|var|async function)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(async\\s*)?(function|\\()`;
    const rg = spawnSync("rg", ["--line-number", "--no-heading", "--color", "never", "--glob", "!node_modules", "--glob", "!.git", "--", pattern, resolve(workdir)], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (rg.status === 0) return parseRgMatches(rg.stdout);

    const grep = spawnSync("grep", ["-rnE", pattern, resolve(workdir)], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return grep.status === 0 ? parseRgMatches(grep.stdout) : [];
  }

  hover(file: string, line: number, workdir = process.cwd(), radius = 2): string {
    const path = resolvePathAlias(file, resolve(workdir));
    if (!existsSync(path)) return `Error: file not found: ${file}`;
    const lines = readFileSync(path, "utf-8").split("\n");
    const target = Math.max(1, Math.min(Math.floor(line), lines.length));
    const start = Math.max(1, target - radius);
    const end = Math.min(lines.length, target + radius);
    return lines.slice(start - 1, end).map((text, index) => {
      const n = start + index;
      const marker = n === target ? ">" : " ";
      return `${marker} ${n}: ${text}`;
    }).join("\n");
  }
}

let manager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!manager) manager = new LspManager();
  return manager;
}

export function clearLspManagerForTests(): void {
  manager = null;
}

function extractSymbols(content: string, file: string): DocumentSymbol[] {
  const result: DocumentSymbol[] = [];
  const lines = content.split("\n");
  lines.forEach((text, index) => {
    const line = index + 1;
    const trimmed = text.trim();
    const matchers: Array<[RegExp, DocumentSymbol["kind"]]> = [
      [/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/, "function"],
      [/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class"],
      [/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/, "interface"],
      [/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/, "type"],
      [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, "variable"],
      [/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, "method"],
    ];
    for (const [regex, kind] of matchers) {
      const match = trimmed.match(regex);
      if (!match?.[1]) continue;
      result.push({ name: match[1], kind, file, line, text: trimmed });
      break;
    }
  });
  return result;
}

function parseRgMatches(output: string): DefinitionMatch[] {
  return output.split("\n").filter(Boolean).slice(0, 100).map(line => {
    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (!match) return null;
    return {
      file: match[1] || basename(line),
      line: Number(match[2]),
      text: match[3]?.trim() || "",
    };
  }).filter((item): item is DefinitionMatch => !!item);
}
