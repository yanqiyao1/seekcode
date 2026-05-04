/** AGENTS.md — hierarchical project context injection.
 *
 * Adopted from OpenAI Codex: reads AGENTS.md from the workspace root and
 * parent directories (up to filesystem boundary or ~), merges them with
 * child-overrides-parent semantics, and injects into the system prompt.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, parse } from "node:path";

export interface AgentsMdResult {
  content: string;
  sourceFiles: string[];
}

/**
 * Read AGENTS.md files hierarchically from cwd up to a boundary.
 *
 * Strategy:
 * 1. Start at cwd, walk up directory tree
 * 2. Read AGENTS.md at each level
 * 3. Stop at filesystem root, home directory, or .git boundary
 * 4. Child directories override parent (more specific wins)
 * 5. Aggregate into a single context block
 */
export function readAgentsMd(cwd: string = process.cwd()): AgentsMdResult {
  const sources: string[] = [];
  const segments: string[] = [];
  let current = resolve(cwd);
  const home = resolve(process.env.HOME || "~");
  const root = parse(current).root;

  const visited = new Set<string>();

  while (true) {
    if (visited.has(current)) break;
    visited.add(current);

    const candidate = resolve(current, "AGENTS.md");
    if (existsSync(candidate) && !visited.has(candidate)) {
      visited.add(candidate);
      try {
        const content = readFileSync(candidate, "utf-8").trim();
        if (content) {
          // Prepend: more specific (child) content goes first
          segments.unshift(content);
          sources.unshift(candidate);
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Stop conditions
    if (current === root) break;
    if (current === home) break;

    // Stop at .git boundary (project root)
    if (existsSync(resolve(current, ".git"))) {
      // Read this level's AGENTS.md but don't go further up
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      // Check one level above .git for monorepo scenarios
      const above = resolve(current, "AGENTS.md");
      if (existsSync(above) && !visited.has(above)) {
        visited.add(above);
        try {
          const content = readFileSync(above, "utf-8").trim();
          if (content) {
            segments.unshift(content);
            sources.unshift(above);
          }
        } catch { /* */ }
      }
      break;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const content = segments.length > 0
    ? `## Project Context (AGENTS.md)\n\n${segments.join("\n\n---\n\n")}`
    : "";

  return { content, sourceFiles: sources };
}

/**
 * Inject AGENTS.md content into the system prompt if found.
 */
export function injectAgentsMd(systemPrompt: string, cwd?: string): string {
  const { content, sourceFiles } = readAgentsMd(cwd);

  if (!content || sourceFiles.length === 0) {
    return systemPrompt;
  }

  const injection = [
    content,
    `\n_Source: ${sourceFiles.join(", ")}_`,
    "\nFollow any project-specific conventions, guidelines, and instructions from AGENTS.md above. These instructions supplement, and may override, the default agent behavior.",
  ].join("\n");

  return systemPrompt + "\n\n" + injection;
}
