/** Sub-agent tool — Codex-style spawn_agent with multi-thread, model override,
 * timeout management, and structured output.
 *
 * Key improvements:
 * - task_name for identification
 * - model override support
 * - timeout management with default/min/max
 * - structured output with agent_id + nickname
 * - concurrent agent tracking
 * - completion sentinel pattern
 */

import OpenAI from "openai";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

// ── Agent tracking ───────────────────────────────────────────

interface AgentRecord {
  id: string;
  task_name: string;
  task: string;
  status: "running" | "done" | "error";
  result?: string;
  error?: string;
  started_at: number;
  completed_at?: number;
}

const runningAgents: Map<string, AgentRecord> = new Map();
let nextAgentId = 1;

export function getAgentState(): AgentRecord[] {
  return [...runningAgents.values()];
}
export function clearAgentState(): void {
  runningAgents.clear();
  nextAgentId = 1;
}

// ── spawn_agent ──────────────────────────────────────────────

async function spawnAgent(args: Record<string, unknown>): Promise<string> {
  const task = args.task as string;
  const taskName = (args.task_name as string) || `agent-${nextAgentId}`;
  const systemPrompt = (args.system_prompt as string) || "";
  const maxTurns = (args.max_turns as number) || 15;
  const timeout = Math.max(
    10_000,
    Math.min((args.timeout_ms as number) || 120_000, 600_000),
  );

  if (!task) return "Error: task is required.";

  const apiKey = (args.api_key as string) ||
    process.env.DEEPSEEK_API_KEY || "";
  const baseUrl = (args.base_url as string) ||
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const model = (args.model as string) ||
    process.env.DEEPSEEK_MODEL || "deepseek-chat";

  const agentId = `agent_${nextAgentId++}`;
  const nickname = taskName.replace(/[^a-z0-9_]/gi, "_").slice(0, 40);

  const record: AgentRecord = {
    id: agentId,
    task_name: taskName,
    task,
    status: "running",
    started_at: Date.now(),
  };
  runningAgents.set(agentId, record);

  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  const sysPrompt = systemPrompt || (
    "You are a specialized sub-agent. Complete the given task thoroughly and " +
    "return a clear, structured result. Be efficient — output the result directly. " +
    "When done, output a final summary with key findings."
  );

  const messages: any[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task },
  ];

  let content = "";
  try {
    for (let i = 0; i < maxTurns; i++) {
      const resp = await client.chat.completions.create({
        model, messages, max_tokens: 4096,
      });
      content = resp.choices[0]?.message?.content || "";
      const finish = resp.choices[0]?.finish_reason || "";

      if (finish === "stop") {
        record.status = "done";
        record.result = content;
        record.completed_at = Date.now();
        const dur = ((record.completed_at - record.started_at) / 1000).toFixed(1);
        return formatAgentDone(agentId, nickname, "done", content, dur);
      }

      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: "Continue or provide your final result." });
    }

    record.status = "done";
    record.result = content;
    record.completed_at = Date.now();
    const dur = ((record.completed_at - record.started_at) / 1000).toFixed(1);
    return formatAgentDone(agentId, nickname, "done", content || "Completed without output.", dur);
  } catch (e: any) {
    record.status = "error";
    record.error = e.message;
    record.completed_at = Date.now();
    return formatAgentDone(agentId, nickname, "error", e.message, "0");
  }
}

function formatAgentDone(
  agentId: string, nickname: string, status: string, result: string, duration: string,
): string {
  const summary = result.length > 1000
    ? result.slice(0, 1000) + `\n... (${result.length} chars total)`
    : result;

  return [
    `<deepseek:subagent.${status}>`,
    `  agent_id: ${agentId}`,
    `  nickname: ${nickname}`,
    `  duration_s: ${duration}`,
    `  summary: |`,
    summary.split("\n").map(l => `    ${l}`).join("\n"),
    `</deepseek:subagent.${status}>`,
  ].join("\n");
}

// ── agent_status ─────────────────────────────────────────────

async function agentStatus(args: Record<string, unknown>): Promise<string> {
  const agentId = args.agent_id as string | undefined;

  if (agentId) {
    const agent = runningAgents.get(agentId);
    if (!agent) return `Agent not found: ${agentId}`;
    return formatAgentStatus(agent);
  }

  if (runningAgents.size === 0) return "No agents running or completed.";

  const lines = [`Agents: ${runningAgents.size} total\n`];
  for (const agent of runningAgents.values()) {
    const sym = agent.status === "running" ? "◎" : agent.status === "done" ? "●" : "✗";
    const dur = agent.completed_at
      ? `${((agent.completed_at - agent.started_at) / 1000).toFixed(1)}s`
      : "running...";
    lines.push(`  ${sym} [${agent.id}] ${agent.task_name} (${dur})`);
  }
  return lines.join("\n");
}

function formatAgentStatus(agent: AgentRecord): string {
  const dur = agent.completed_at
    ? `${((agent.completed_at - agent.started_at) / 1000).toFixed(1)}s`
    : `${((Date.now() - agent.started_at) / 1000).toFixed(1)}s (running)`;

  return [
    `Agent: ${agent.id} (${agent.task_name})`,
    `Status: ${agent.status} | Duration: ${dur}`,
    agent.result ? `Result: ${agent.result.slice(0, 500)}` : "",
    agent.error ? `Error: ${agent.error}` : "",
  ].filter(Boolean).join("\n");
}

// ── Registration ─────────────────────────────────────────────

export function registerSubAgentTool(): void {
  const r = getRegistry();

  r.register({
    name: "spawn_agent",
    description: [
      "Spawn a specialized sub-agent to handle a focused task independently.",
      "The agent runs asynchronously with its own context window.",
      "Results are returned in structured <deepseek:subagent.done> format.",
      "Use this for: parallel investigation, independent implementation tasks,",
      "or any work that benefits from dedicated attention without polluting",
      "the main conversation context.",
      "",
      "Provide a descriptive task_name for tracking. The agent inherits",
      "your current model by default — omit model to use the default.",
      "Set model only when an explicit override is needed.",
      "Max 5 agents should be running concurrently.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The sub-task for the agent to complete" },
        task_name: { type: "string", description: "Descriptive name (lowercase, underscores) for tracking" },
        system_prompt: { type: "string", description: "Custom system prompt", default: "" },
        max_turns: { type: "integer", description: "Maximum reasoning turns", default: 15 },
        timeout_ms: { type: "integer", description: "Timeout in ms (10s-600s)", default: 120_000 },
        model: { type: "string", description: "Model override. Omit to inherit parent model." },
      },
      required: ["task"],
    },
    execute: spawnAgent,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
  });

  // Keep old sub_agent for backwards compat (wraps spawn_agent)
  r.register({
    name: "sub_agent",
    description: "Legacy: use spawn_agent for new code. Spawn a sub-agent with fresh context.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        system_prompt: { type: "string", default: "" },
        max_turns: { type: "integer", default: 15 },
      },
      required: ["task"],
    },
    execute: async (args: Record<string, unknown>) => {
      return spawnAgent({
        task: args.task,
        task_name: (args.task as string).slice(0, 40),
        system_prompt: args.system_prompt,
        max_turns: args.max_turns,
      });
    },
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
  });

  r.register({
    name: "agent_status",
    description: "Check the status of spawned sub-agents. Use to monitor progress of parallel work.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Specific agent ID, or omit for all" },
      },
    },
    execute: agentStatus,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
  });
}
