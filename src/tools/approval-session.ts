import { DenialReason, getApprovalCache } from "./approval-cache.js";
import { rememberAlwaysAllow } from "./permission-ruleset.js";

export type ApprovalChoice = "always" | "once" | "deny";

export function applyApprovalChoice(
  toolName: string,
  args: Record<string, unknown>,
  choice: ApprovalChoice,
): { level: "success" | "warning"; message: string } {
  const cache = getApprovalCache();
  if (choice === "always") {
    cache.rememberApproval(toolName, "always", args);
    rememberAlwaysAllow(toolName, args);
    return { level: "success", message: `Approved ${toolName} for matching requests this session.` };
  }
  if (choice === "once") {
    cache.rememberApproval(toolName, "once", args);
    return { level: "success", message: `Approved ${toolName} once.` };
  }
  cache.rememberDenial(toolName, DenialReason.USER_DENIED, args);
  return { level: "warning", message: `Denied ${toolName}.` };
}
