/** Apply patch tool. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { applyPatch as applyAdvancedPatch, formatPatchResult } from "./patch-advanced.js";
import { resolvePathAlias } from "./path-resolution.js";

function normalizePatchWorkdir(args: Record<string, unknown>): string | undefined {
  if (typeof args.workdir === "string" && args.workdir.trim()) return args.workdir.trim();
  if (typeof args.cwd === "string" && args.cwd.trim()) return args.cwd.trim();
  if (typeof args.root === "string" && args.root.trim()) return args.root.trim();
  return undefined;
}

async function applyPatch(args: Record<string, unknown>): Promise<string> {
  if (typeof args.patch !== "string" || !args.patch.trim()) {
    return "Patch failed:\npatch must be a non-empty string";
  }
  const workdirInput = normalizePatchWorkdir(args);
  const rawWorkdirInput = args.workdir ?? args.cwd ?? args.root;
  if (rawWorkdirInput !== undefined && workdirInput === undefined) {
    return "Patch failed:\nworkdir must be a string";
  }
  const patch = args.patch;
  const base = typeof args.__workspace_path === "string" && args.__workspace_path.trim()
    ? args.__workspace_path.trim()
    : process.cwd();
  const workdir = workdirInput ? resolvePathAlias(workdirInput, base) : base;
  try {
    const results = applyAdvancedPatch(patch, { workdir });
    const formatted = formatPatchResult(results);
    return results.some(result => result.type === "error")
      ? `Patch failed:\n${formatted}`
      : `Patch applied successfully:\n${formatted}`;
  } catch (e: any) { return `Patch failed:\n${e.message}`; }
}

export function registerPatchTool(): void {
  getRegistry().register({
    name: "apply_patch", description: "Apply a unified diff patch.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string" },
        workdir: { type: "string", description: "Optional workspace root where the patch is applied." },
        target_file: { type: "string", default: "" },
      },
      required: ["patch"],
    },
    execute: applyPatch,
    permission: PermissionLevel.ASK,
    category: "file",
    parallelOk: false,
    destructive: true,
    searchHint: "apply unified diff",
    resultKind: "diff",
    validateInput: (args) => {
      const patch = args.patch;
      if (typeof patch !== "string" || !patch.trim()) {
        return { ok: false, message: "patch must be a non-empty string" };
      }
      const workdir = normalizePatchWorkdir(args);
      if ((args.workdir ?? args.cwd ?? args.root) !== undefined && workdir === undefined) {
        return { ok: false, message: "workdir must be a string" };
      }
      return workdir === undefined
        ? { ok: true }
        : { ok: true, args: { ...args, workdir } };
    },
  });
}
