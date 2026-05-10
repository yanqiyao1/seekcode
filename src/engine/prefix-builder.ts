/** Shared construction of the immutable prompt-cache prefix. */

import type { Config } from "../config.js";
import { followInstructionText, readAgentsMd, type AgentsMdResult } from "./agents-md.js";
import { buildSystemPrompt, buildToolsDescription } from "./context.js";
import { buildSkillsContext, SkillRegistry, type SkillInfo } from "./skills.js";
import { ImmutablePrefix } from "./prefix.js";
import type { ToolRegistry } from "../tools/registry.js";
import { getMode } from "../modes/base.js";

export interface PinnedPrefixContext {
  agentsMd: AgentsMdResult;
  skills: SkillInfo[];
}

export function loadPinnedPrefixContext(
  config: Config,
  workspacePath: string,
): PinnedPrefixContext {
  return {
    agentsMd: readAgentsMd(workspacePath),
    skills: SkillRegistry.discover({ workspaceDir: workspacePath, skillsDir: config.skills_dir }).list(),
  };
}

export function buildPinnedPrefix(
  config: Config,
  workspacePath: string,
  tools: ToolRegistry,
  context: PinnedPrefixContext = loadPinnedPrefixContext(config, workspacePath),
): ImmutablePrefix {
  const visibleTools = getMode(config.mode).filterTools(tools.listActive());
  const base = buildSystemPrompt(config, workspacePath, buildToolsDescription(visibleTools));
  const withAgents = injectAgentsMdResult(base, context.agentsMd);
  const skillsContext = buildSkillsContext(context.skills);
  const systemPrompt = skillsContext ? `${withAgents}\n\n${skillsContext}` : withAgents;
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

function injectAgentsMdResult(systemPrompt: string, result: AgentsMdResult): string {
  if (!result.content || result.sourceFiles.length === 0) return systemPrompt;

  const injection = [
    result.content,
    `\n_Source: ${result.sourceFiles.join(", ")}_`,
    `\n${followInstructionText(result)}`,
  ].join("\n");

  return `${systemPrompt}\n\n${injection}`;
}

function buildMemoryIndex(systemPrompt: string, basePrompt: string): string | null {
  const extra = systemPrompt.slice(basePrompt.length).trim();
  return extra || null;
}
