/** Permission ruleset system — pattern-matching allow/deny/ask with wildcards.
 *
 * Adopted from OpenCode: replaces simple approval cache with a ruleset-based
 * system supporting tool-name patterns, wildcards, "always" arrays for
 * remembered decisions, and session-scoped persistence.
 */

// ── Types ────────────────────────────────────────────────────

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  permission: string;   // tool name or pattern (supports * wildcard)
  pattern: string;      // argument pattern to match (e.g., "*.ts", "rm *")
  action: PermissionAction;
}

export interface PermissionRequest {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  sessionID?: string;
  /** Specific argument patterns the model is asking about */
  patterns?: string[];
}

export interface PermissionResult {
  action: PermissionAction;
  matchedRule?: string;
  reason?: string;
}

// ── Session-scoped memory ───────────────────────────────────

// Tools the user has said "always allow" for
const alwaysAllow: Set<string> = new Set();
// Tools the user has said "always deny" for
const alwaysDeny: Set<string> = new Set();
// Custom rules
const customRules: PermissionRule[] = [];
// Built-in defaults
const defaultRules: PermissionRule[] = [
  // Safe read operations — always allow
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "ls", pattern: "*", action: "allow" },
  { permission: "search", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "git_status", pattern: "*", action: "allow" },
  { permission: "git_diff", pattern: "*", action: "allow" },
  { permission: "git_log", pattern: "*", action: "allow" },
  { permission: "git_branch", pattern: "*", action: "allow" },
  { permission: "web_search", pattern: "*", action: "allow" },
  { permission: "web_fetch", pattern: "*", action: "allow" },
  { permission: "think", pattern: "*", action: "allow" },
  { permission: "get_goal", pattern: "*", action: "allow" },
  { permission: "plan_status", pattern: "*", action: "allow" },
  { permission: "agent_status", pattern: "*", action: "allow" },
  { permission: "checklist_write", pattern: "*", action: "allow" },
  { permission: "update_plan", pattern: "*", action: "allow" },
  { permission: "note", pattern: "*", action: "allow" },
  { permission: "rlm_query", pattern: "*", action: "allow" },
  { permission: "spawn_agent", pattern: "*", action: "allow" },
  { permission: "sub_agent", pattern: "*", action: "allow" },

  // Destructive — always deny
  { permission: "bash", pattern: "rm -rf /*", action: "deny" },
  { permission: "bash", pattern: "> /dev/sd*", action: "deny" },
  { permission: "bash", pattern: "mkfs.*", action: "deny" },
  { permission: "bash", pattern: "dd if=* of=/dev/*", action: "deny" },
  { permission: "bash", pattern: "chmod 777 *", action: "deny" },
  { permission: "bash", pattern: ":(){ :|:& };:", action: "deny" },

  // Write operations — ask by default
  { permission: "write", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
  { permission: "apply_patch", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "*", action: "ask" },
];

// ── Matching ────────────────────────────────────────────────

function matchWildcard(pattern: string, value: string): boolean {
  // Convert glob pattern to regex
  const regexStr = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".") + "$";
  try {
    return new RegExp(regexStr, "i").test(value);
  } catch {
    return pattern === value;
  }
}

function matchRule(rule: PermissionRule, request: PermissionRequest): boolean {
  // Match tool name
  if (!matchWildcard(rule.permission, request.toolName)) return false;

  // Match pattern against args or patterns
  if (rule.pattern === "*") return true;

  // Check specific patterns from the request
  if (request.patterns) {
    return request.patterns.some(p => matchWildcard(rule.pattern, p));
  }

  // Check args for pattern match
  if (request.toolArgs) {
    const argsStr = Object.values(request.toolArgs).join(" ");
    return matchWildcard(rule.pattern, argsStr);
  }

  return false;
}

// ── Main API ────────────────────────────────────────────────

export function checkPermission(request: PermissionRequest): PermissionResult {
  // Check always-allow first
  if (alwaysAllow.has(request.toolName)) {
    return { action: "allow", reason: "Always allowed for this session" };
  }

  // Check always-deny
  if (alwaysDeny.has(request.toolName)) {
    return { action: "deny", reason: "Always denied for this session" };
  }

  // Check custom rules (highest priority)
  for (const rule of customRules) {
    if (matchRule(rule, request)) {
      return { action: rule.action, matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Custom rule matched" };
    }
  }

  // Check default rules
  for (const rule of defaultRules) {
    if (matchRule(rule, request)) {
      return { action: rule.action, matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Default rule matched" };
    }
  }

  // Default: ask
  return { action: "ask", reason: "No matching rule" };
}

export function addRule(rule: PermissionRule): void {
  // Deduplicate
  const idx = customRules.findIndex(
    r => r.permission === rule.permission && r.pattern === rule.pattern,
  );
  if (idx >= 0) {
    customRules[idx] = rule;
  } else {
    customRules.push(rule);
  }
}

export function removeRule(permission: string, pattern: string): boolean {
  const idx = customRules.findIndex(
    r => r.permission === permission && r.pattern === pattern,
  );
  if (idx >= 0) {
    customRules.splice(idx, 1);
    return true;
  }
  return false;
}

export function getAllRules(): PermissionRule[] {
  return [...defaultRules, ...customRules];
}

// ── Session memory ──────────────────────────────────────────

export function rememberAlwaysAllow(toolName: string): void {
  alwaysAllow.add(toolName);
  alwaysDeny.delete(toolName);
}

export function rememberAlwaysDeny(toolName: string): void {
  alwaysDeny.add(toolName);
  alwaysAllow.delete(toolName);
}

export function forgetTool(toolName: string): void {
  alwaysAllow.delete(toolName);
  alwaysDeny.delete(toolName);
}

export function isAlwaysAllowed(toolName: string): boolean {
  return alwaysAllow.has(toolName);
}

export function isAlwaysDenied(toolName: string): boolean {
  return alwaysDeny.has(toolName);
}

export function getSessionMemory(): { allow: string[]; deny: string[] } {
  return {
    allow: [...alwaysAllow],
    deny: [...alwaysDeny],
  };
}

export function clearSessionMemory(): void {
  alwaysAllow.clear();
  alwaysDeny.clear();
}

export function clearAll(): void {
  alwaysAllow.clear();
  alwaysDeny.clear();
  customRules.length = 0;
}
