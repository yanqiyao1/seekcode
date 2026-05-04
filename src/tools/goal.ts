/** Goal tracking tools — create_goal, get_goal, update_goal.
 *
 * Adopted from OpenAI Codex: persistent thread-level goals with token budgets
 * and usage accounting. Goals provide a north-star objective that persists
 * across turns and sessions.
 */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

// ── Goal state ───────────────────────────────────────────────

interface ActiveGoal {
  objective: string;
  token_budget: number | null;
  created_at: number;
  started_at: number;
  // Usage tracking
  tokens_used: number;
  turns_used: number;
  elapsed_ms: number;
  status: "active" | "complete" | "abandoned";
  result?: string;
}

let activeGoal: ActiveGoal | null = null;
// Track per-session usage for the goal
let goalTokensUsed = 0;
let goalTurnsUsed = 0;
let goalStartTime = 0;

export function getGoalState() { return activeGoal; }
export function clearGoalState() { activeGoal = null; goalTokensUsed = 0; goalTurnsUsed = 0; goalStartTime = 0; }

export function trackGoalTokenUsage(tokens: number): void {
  goalTokensUsed += tokens;
  if (activeGoal) activeGoal.tokens_used = goalTokensUsed;
}
export function trackGoalTurn(): void {
  goalTurnsUsed++;
  if (activeGoal) activeGoal.turns_used = goalTurnsUsed;
}
export function trackGoalElapsed(): void {
  if (activeGoal && goalStartTime) {
    activeGoal.elapsed_ms = Date.now() - goalStartTime;
  }
}

// ── get_goal ─────────────────────────────────────────────────

async function getGoal(): Promise<string> {
  if (!activeGoal) {
    return "No active goal. Use create_goal to set an objective with an optional token budget.";
  }

  const elapsed = Date.now() - goalStartTime;
  const elapsedStr = formatDuration(elapsed);
  const budgetStr = activeGoal.token_budget
    ? `${activeGoal.tokens_used.toLocaleString()} / ${activeGoal.token_budget.toLocaleString()} tokens`
    : `${activeGoal.tokens_used.toLocaleString()} tokens used (unlimited budget)`;

  return [
    `## Goal: ${activeGoal.objective}`,
    `Status: ${activeGoal.status} | Created: ${new Date(activeGoal.created_at).toISOString().slice(0, 16)}`,
    `Budget: ${budgetStr}`,
    `Turns: ${goalTurnsUsed} | Elapsed: ${elapsedStr}`,
    activeGoal.status === "complete" ? `Result: ${activeGoal.result || "Completed"}` : "",
  ].filter(Boolean).join("\n");
}

// ── create_goal ──────────────────────────────────────────────

async function createGoal(args: Record<string, unknown>): Promise<string> {
  const objective = args.objective as string;
  const tokenBudget = (args.token_budget as number) || null;

  if (activeGoal) {
    return `Error: A goal is already active: "${activeGoal.objective}". Use update_goal to change status, or complete/abandon the current goal first.`;
  }

  if (!objective || objective.trim().length === 0) {
    return "Error: objective is required. Provide a concrete, verifiable goal description.";
  }

  if (tokenBudget && tokenBudget <= 0) {
    return "Error: token_budget must be a positive integer or omitted for unlimited.";
  }

  const now = Date.now();
  activeGoal = {
    objective: objective.trim(),
    token_budget: tokenBudget,
    created_at: now,
    started_at: now,
    tokens_used: 0,
    turns_used: 0,
    elapsed_ms: 0,
    status: "active",
  };
  goalTokensUsed = 0;
  goalTurnsUsed = 0;
  goalStartTime = now;

  const budgetNote = tokenBudget
    ? ` with a ${tokenBudget.toLocaleString()} token budget`
    : " (unlimited budget)";

  return `Goal created${budgetNote}: "${objective.trim()}"\n\nTrack progress with get_goal. Mark complete with update_goal status=complete when the objective is achieved.`;
}

// ── update_goal ──────────────────────────────────────────────

async function updateGoal(args: Record<string, unknown>): Promise<string> {
  if (!activeGoal) {
    return "No active goal. Use create_goal to set an objective first.";
  }

  const status = args.status as string | undefined;
  if (!status) {
    return "Error: status is required. Use 'complete' to mark the goal achieved.";
  }

  if (status === "complete") {
    const result = (args.result as string) || "";
    activeGoal.status = "complete";
    activeGoal.result = result;
    activeGoal.elapsed_ms = Date.now() - goalStartTime;
    const budgetUsed = activeGoal.token_budget
      ? `\nToken budget: ${activeGoal.tokens_used.toLocaleString()} / ${activeGoal.token_budget.toLocaleString()} used`
      : `\nTokens used: ${activeGoal.tokens_used.toLocaleString()}`;

    return `Goal marked complete: "${activeGoal.objective}"\nTurns: ${goalTurnsUsed} | Elapsed: ${formatDuration(activeGoal.elapsed_ms)}${budgetUsed}${result ? `\nResult: ${result}` : ""}`;
  }

  if (status === "abandon") {
    activeGoal.status = "abandoned";
    return `Goal abandoned: "${activeGoal.objective}"`;
  }

  return `Unknown status: ${status}. Use 'complete' or 'abandon'.`;
}

// ── Helpers ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

// ── Registration ─────────────────────────────────────────────

export function registerGoalTools(): void {
  const r = getRegistry();

  r.register({
    name: "get_goal",
    description: "Get the current goal for this session including objective, status, token budget, usage, and elapsed time. Use this before starting work to orient yourself, and periodically to check progress.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: getGoal,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
  });

  r.register({
    name: "create_goal",
    description: "Create a goal only when explicitly requested by the user. Do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal already exists; use update_goal to manage the current goal.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Required. The concrete, verifiable objective to pursue." },
        token_budget: { type: "integer", description: "Optional positive token budget for the goal." },
      },
      required: ["objective"],
    },
    execute: createGoal,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
  });

  r.register({
    name: "update_goal",
    description: "Update the existing goal. Use only to mark the goal complete (when objective is achieved) or abandoned. Do not mark complete merely because budget is nearly exhausted or you are stopping work. Report final token usage when completing a budgeted goal.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["complete", "abandon"], description: "Required. Set to 'complete' only when the objective is achieved and no required work remains." },
        result: { type: "string", description: "Optional. Summary of what was accomplished." },
      },
      required: ["status"],
    },
    execute: updateGoal,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
  });
}
