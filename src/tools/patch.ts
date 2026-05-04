/** Apply patch tool. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { applyPatch as applyAdvancedPatch, formatPatchResult } from "./patch-advanced.js";

async function applyPatch(args: Record<string, unknown>): Promise<string> {
  const patch = args.patch as string;
  const workdir = String(args.workdir || args.cwd || args.root || process.cwd());
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
    execute: applyPatch, permission: PermissionLevel.ASK, category: "file", parallelOk: false,
  });
}
