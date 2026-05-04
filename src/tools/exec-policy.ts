/** Exec policy — rule-based shell command safety (adopted from DeepSeek-TUI).
 *
 * Replaces the hardcoded dangerous-strings list with a configurable
 * policy that supports exact-match allow/deny, prefix rules, and
 * regex patterns.
 */

// ── Rule types ───────────────────────────────────────────────

export type Decision = "allow" | "deny" | "ask";

interface BaseRule {
  decision: Decision;
  justification?: string;
}

interface ExactRule extends BaseRule {
  type: "exact";
  command: string;
}

interface PrefixRule extends BaseRule {
  type: "prefix";
  prefix: string[];
}

interface RegexRule extends BaseRule {
  type: "regex";
  pattern: string;
}

type Rule = ExactRule | PrefixRule | RegexRule;

// ── Default policy ───────────────────────────────────────────

const DEFAULT_RULES: Rule[] = [
  // Always deny — irreversible destruction
  { type: "prefix", prefix: ["rm", "-rf", "/"], decision: "deny", justification: "Recursive root deletion" },
  { type: "regex", pattern: ">\\s*/dev/sd[a-z]", decision: "deny", justification: "Write to raw block device" },
  { type: "regex", pattern: "mkfs\\.", decision: "deny", justification: "Filesystem format" },
  { type: "regex", pattern: "dd\\s+if=", decision: "deny", justification: "Raw device copy" },
  { type: "regex", pattern: ":\\{\\s*:\\|:&\\s*\\};:", decision: "deny", justification: "Fork bomb" },
  { type: "regex", pattern: "chmod\\s+(-R\\s+)?777", decision: "deny", justification: "World-writable permissions" },

  // Always allow — safe read-only operations
  { type: "exact", command: "ls", decision: "allow", justification: "Safe: directory listing" },
  { type: "exact", command: "pwd", decision: "allow", justification: "Safe: print working directory" },
  { type: "prefix", prefix: ["echo"], decision: "allow", justification: "Safe: output text" },
  { type: "prefix", prefix: ["cat"], decision: "allow", justification: "Safe: read file" },
  { type: "prefix", prefix: ["head"], decision: "allow", justification: "Safe: read file" },
  { type: "prefix", prefix: ["tail"], decision: "allow", justification: "Safe: read file" },
  { type: "prefix", prefix: ["find"], decision: "allow", justification: "Safe: search files" },
  { type: "prefix", prefix: ["grep"], decision: "allow", justification: "Safe: search text" },
  { type: "prefix", prefix: ["wc"], decision: "allow", justification: "Safe: count" },
  { type: "prefix", prefix: ["which"], decision: "allow", justification: "Safe: locate binary" },
  { type: "prefix", prefix: ["git", "status"], decision: "allow", justification: "Safe: git status" },
  { type: "prefix", prefix: ["git", "diff"], decision: "allow", justification: "Safe: git diff" },
  { type: "prefix", prefix: ["git", "log"], decision: "allow", justification: "Safe: git log" },
  { type: "prefix", prefix: ["git", "branch"], decision: "allow", justification: "Safe: git branch" },
  { type: "prefix", prefix: ["npm", "test"], decision: "allow", justification: "Safe: run tests" },
  { type: "prefix", prefix: ["npm", "run", "build"], decision: "allow", justification: "Safe: build" },
  { type: "prefix", prefix: ["npx", "tsc", "--noEmit"], decision: "allow", justification: "Safe: type check" },
  { type: "prefix", prefix: ["node", "--version"], decision: "allow", justification: "Safe: version check" },
  { type: "prefix", prefix: ["node", "-e"], decision: "allow", justification: "Safe: inline eval" },
];

// ── Policy engine ────────────────────────────────────────────

let customRules: Rule[] = [];

export function setCustomRules(rules: Rule[]): void {
  customRules = rules;
}

export function addRule(rule: Rule): void {
  customRules.push(rule);
}

function tokenize(command: string): string[] {
  // Simple tokenization — split on whitespace, respect basic quoting
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of command) {
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      current += ch;
    } else if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      current += ch;
    } else {
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === " " || ch === "\t") {
        if (current) { tokens.push(current); current = ""; }
        continue;
      }
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function checkCommand(command: string): { decision: Decision; justification: string } {
  const tokens = tokenize(command);
  if (!tokens.length) return { decision: "allow", justification: "Empty command" };

  const allRules = [...DEFAULT_RULES, ...customRules];

  // Check deny rules first (most specific)
  for (const rule of allRules) {
    if (matches(tokens, rule)) {
      return { decision: rule.decision, justification: rule.justification || "Policy rule matched" };
    }
  }

  // Default: ask for approval
  return { decision: "ask", justification: "No matching policy rule" };
}

function matches(tokens: string[], rule: Rule): boolean {
  switch (rule.type) {
    case "exact":
      return tokens.length >= 1 && tokens[0] === rule.command;
    case "prefix":
      if (tokens.length < rule.prefix.length) return false;
      return rule.prefix.every((p, i) => tokens[i] === p);
    case "regex": {
      const cmd = tokens.join(" ");
      try {
        return new RegExp(rule.pattern).test(cmd);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export function getAllRules(): Rule[] {
  return [...DEFAULT_RULES, ...customRules];
}
