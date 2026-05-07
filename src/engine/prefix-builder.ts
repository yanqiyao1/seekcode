/** Shared construction of the immutable prompt-cache prefix. */

import type { Config } from "../config.js";
import { injectAgentsMd } from "./agents-md.js";
import { buildSystemPrompt, buildToolsDescription } from "./context.js";
import { injectSkills } from "./skills.js";
import { ImmutablePrefix } from "./prefix.js";
import type { ToolRegistry } from "../tools/registry.js";
import { getMode } from "../modes/base.js";

export function buildPinnedPrefix(
  config: Config,
  workspacePath: string,
  tools: ToolRegistry,
): ImmutablePrefix {
  const visibleTools = getMode(config.mode).filterTools(tools.listActive());
  const base = buildSystemPrompt(config, workspacePath, buildToolsDescription(visibleTools));
  const withAgents = injectAgentsMd(base, workspacePath);
  const systemPrompt = injectSkills(withAgents, workspacePath, config.skills_dir);
  return new ImmutablePrefix({
    systemPrompt,
    toolSchemas: visibleTools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    memoryIndex: buildMemoryIndex(systemPrompt, base),
  });
}

function buildMemoryIndex(systemPrompt: string, basePrompt: string): string | null {
  const extra = systemPrompt.slice(basePrompt.length).trim();
  return extra || null;
}
