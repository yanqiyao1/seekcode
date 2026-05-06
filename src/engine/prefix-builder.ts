/** Shared construction of the immutable prompt-cache prefix. */

import type { Config } from "../config.js";
import { injectAgentsMd } from "./agents-md.js";
import { buildSystemPrompt, buildToolsDescription } from "./context.js";
import { injectSkills } from "./skills.js";
import { ImmutablePrefix } from "./prefix.js";
import type { ToolRegistry } from "../tools/registry.js";

export function buildPinnedPrefix(
  config: Config,
  workspacePath: string,
  tools: ToolRegistry,
): ImmutablePrefix {
  const base = buildSystemPrompt(config, workspacePath, buildToolsDescription(tools.listAll()));
  const withAgents = injectAgentsMd(base, workspacePath);
  const systemPrompt = injectSkills(withAgents, workspacePath, config.skills_dir);
  return new ImmutablePrefix({
    systemPrompt,
    toolSchemas: tools.toOpenAISchemas({ activeOnly: false }),
    memoryIndex: buildMemoryIndex(systemPrompt, base),
  });
}

function buildMemoryIndex(systemPrompt: string, basePrompt: string): string | null {
  const extra = systemPrompt.slice(basePrompt.length).trim();
  return extra || null;
}
