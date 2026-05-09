import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkApprovalCache, clearApprovalCache } from "../src/tools/approval-cache.js";
import { applyApprovalChoice } from "../src/tools/approval-session.js";
import { checkPermission, clearAll as clearPermissionRules, getSessionMemory, isAlwaysAllowed, isAlwaysDenied } from "../src/tools/permission-ruleset.js";

beforeEach(() => {
  clearApprovalCache();
  clearPermissionRules();
});

afterEach(() => {
  clearApprovalCache();
  clearPermissionRules();
});

describe("approval session choices", () => {
  it("keeps a plain deny scoped to the matching request instead of marking the whole tool always denied", () => {
    const args = { command: "npm test", workdir: "." };

    const outcome = applyApprovalChoice("bash", args, "deny");

    expect(outcome).toEqual({ level: "warning", message: "Denied bash." });
    expect(checkApprovalCache("bash", "ask", args)).toMatchObject({ decision: "denied" });
    expect(checkApprovalCache("bash", "ask", { command: "npm run build", workdir: "." })).toMatchObject({ decision: "ask" });
    expect(isAlwaysDenied("bash")).toBe(false);
  });

  it("records pattern-specific allow only for the explicit always choice", () => {
    const args = { command: "npm test", workdir: "." };

    const outcome = applyApprovalChoice("bash", args, "always");

    expect(outcome).toEqual({ level: "success", message: "Approved bash for matching requests this session." });
    expect(isAlwaysAllowed("bash")).toBe(false);
    expect(isAlwaysAllowed("bash", args)).toBe(true);
    expect(getSessionMemory()).toEqual({ allow: ["bash(npm test)"], deny: [] });
    expect(checkPermission({ toolName: "bash", toolArgs: args, patterns: ["npm test"] })).toMatchObject({ action: "allow" });
    expect(checkPermission({ toolName: "bash", toolArgs: { command: "npm run build", workdir: "." }, patterns: ["npm run build"] })).toMatchObject({ action: "ask" });
    expect(checkApprovalCache("bash", "ask", { command: "npm run build", workdir: "." })).toMatchObject({ decision: "ask" });
  });

  it("keeps once approvals narrow and single-use", () => {
    const args = { path: "README.md" };

    const outcome = applyApprovalChoice("read", args, "once");

    expect(outcome).toEqual({ level: "success", message: "Approved read once." });
    expect(checkApprovalCache("read", "ask", args)).toMatchObject({ decision: "approved" });
    expect(checkApprovalCache("read", "ask", args)).toMatchObject({ decision: "ask" });
    expect(isAlwaysAllowed("read")).toBe(false);
  });
});
