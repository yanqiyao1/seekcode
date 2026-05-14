/** Built-in agent profiles for primary/sub-agent specialization. */

export type AgentProfileName = "general" | "explore" | "scout" | "build" | "plan" | "compaction";

export interface AgentProfile {
  name: AgentProfileName;
  description: string;
  defaultModel: string;
  defaultMaxTurns: number;
  permissionPolicy: "read-only" | "ask" | "build";
  systemPrompt: string;
  hidden?: boolean;
}

const PROFILES: Record<AgentProfileName, AgentProfile> = {
  general: {
    name: "general",
    description: "General-purpose sub-agent for bounded independent work.",
    defaultModel: "deepseek-v4-flash",
    defaultMaxTurns: 15,
    permissionPolicy: "ask",
    systemPrompt: "You are a specialized sub-agent. Complete the focused task directly, report key findings, and avoid unrelated exploration.",
  },
  explore: {
    name: "explore",
    description: "Read-only codebase exploration and architecture analysis.",
    defaultModel: "deepseek-v4-flash",
    defaultMaxTurns: 10,
    permissionPolicy: "read-only",
    systemPrompt: "You are an explore sub-agent. Inspect and reason about code only. Prioritize file references, architecture, risks, and concise findings. Do not propose broad rewrites unless evidence supports them.",
  },
  scout: {
    name: "scout",
    description: "External research and dependency/documentation scouting.",
    defaultModel: "deepseek-v4-flash",
    defaultMaxTurns: 8,
    permissionPolicy: "read-only",
    systemPrompt: "You are a scout sub-agent. Research external documentation or ecosystem facts, cite concrete sources when provided in context, and summarize applicability and risks.",
  },
  build: {
    name: "build",
    description: "Implementation-focused sub-agent for isolated coding tasks.",
    defaultModel: "deepseek-v4-pro",
    defaultMaxTurns: 15,
    permissionPolicy: "build",
    systemPrompt: "You are a build sub-agent. Implement the assigned bounded change, keep scope tight, verify behavior where possible, and report changed files and test results.",
  },
  plan: {
    name: "plan",
    description: "Planning and decomposition sub-agent.",
    defaultModel: "deepseek-v4-flash",
    defaultMaxTurns: 8,
    permissionPolicy: "read-only",
    systemPrompt: "You are a planning sub-agent. Produce a concrete, sequenced plan with risks, dependencies, and verification steps. Do not edit files.",
  },
  compaction: {
    name: "compaction",
    description: "Hidden summarization profile for context compaction.",
    defaultModel: "deepseek-v4-flash",
    defaultMaxTurns: 4,
    permissionPolicy: "read-only",
    hidden: true,
    systemPrompt: "You summarize long agent sessions into structured state: goal, plan, changed files, key evidence, unresolved risks, latest user instruction, and artifact references.",
  },
};

export function normalizeAgentProfileName(name: unknown): AgentProfileName | null {
  if (typeof name !== "string" || !name.trim()) return "general";
  const normalized = name.trim().toLowerCase().replace(/[-\s]/g, "_") as AgentProfileName;
  return PROFILES[normalized] ? normalized : null;
}

export function hasAgentProfile(name: unknown): boolean {
  return normalizeAgentProfileName(name) !== null;
}

export function getAgentProfile(name: unknown): AgentProfile {
  const normalized = normalizeAgentProfileName(name);
  return normalized ? PROFILES[normalized] : PROFILES.general;
}

export function listAgentProfiles(options: { includeHidden?: boolean } = {}): AgentProfile[] {
  return Object.values(PROFILES)
    .filter(profile => options.includeHidden || !profile.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
}
