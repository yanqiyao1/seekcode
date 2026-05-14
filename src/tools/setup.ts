/** Shared built-in tool registration for CLI, TUI, and server runtimes. */

import type { Config } from "../config.js";
import { registerArtifactTools } from "./artifacts.js";
import { registerCustomTools } from "./custom.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerFileTools } from "./file-ops.js";
import { registerGitTools } from "./git.js";
import { registerGoalTools } from "./goal.js";
import { registerPatchTool } from "./patch.js";
import { addRule } from "./permission-ruleset.js";
import { registerPlanTools } from "./plan.js";
import { getRegistry, type ToolRegistry } from "./registry.js";
import { registerRLMTool } from "./rlm-query.js";
import { registerShellTool } from "./shell.js";
import { registerSubAgentTool } from "./sub-agent.js";
import { registerTaskTools } from "./tasks.js";
import { registerThinkTool } from "./think.js";
import { registerToolSearchTool } from "./tool-search.js";
import { registerWebTools } from "./web.js";

export function registerBuiltInTools(config?: Config, options: { clear?: boolean; workspacePath?: string } = {}): ToolRegistry {
  const registry = getRegistry();
  if (options.clear) registry.clear();
  registerFileTools();
  registerShellTool();
  registerGitTools();
  registerWebTools(config?.web);
  registerPatchTool();
  registerThinkTool();
  registerRLMTool();
  registerSubAgentTool();
  registerPlanTools();
  registerGoalTools();
  registerToolSearchTool();
  registerTaskTools();
  registerArtifactTools();
  registerDiagnosticsTools();
  registerCustomTools(options.workspacePath || process.cwd());
  applyConfiguredPermissions(config);
  return registry;
}

export function refreshWebTools(config?: Config): ToolRegistry {
  const registry = getRegistry();
  registerWebTools(config?.web);
  applyConfiguredPermissions(config);
  return registry;
}

function applyConfiguredPermissions(config?: Config): void {
  for (const [permission, action] of Object.entries(config?.permissions || {})) {
    addRule({ permission, pattern: "*", action });
  }
}
