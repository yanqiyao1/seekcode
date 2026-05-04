/** Interaction modes: Plan (read-only), Agent (approval), YOLO (auto-approved). */

import { PermissionLevel, type ApprovalContext, type ToolDef } from "../tools/base.js";

export const MODE_NAMES = ["plan", "agent", "yolo"] as const;
export type ModeName = typeof MODE_NAMES[number];

export interface BaseMode {
  name: string;
  filterTools(tools: ToolDef[]): ToolDef[];
  checkPermission(ctx: ApprovalContext, callbacks?: UICallbacks): Promise<boolean>;
}

export interface UICallbacks {
  onThinking?(text: string): void | Promise<void>;
  onContent?(text: string): void | Promise<void>;
  onToolCallStart?(name: string): void | Promise<void>;
  onToolExecuted?(name: string, preview: string): void | Promise<void>;
  onApiCallStart?(): void | Promise<void>;
  onContextIntervention?(intervention: unknown): void | Promise<void>;
  onRuntimeItem?(item: { type: string; data: unknown; artifact_ids?: string[] }): void | Promise<void>;
  requestApproval?(toolName: string, args: Record<string, unknown>, description: string): Promise<boolean>;
}

const PLAN_ALLOWED_TOOLS = new Set([
  "read",
  "ls",
  "search",
  "glob",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "web_search",
  "web_fetch",
  "think",
  "get_goal",
  "plan_status",
  "checklist_write",
  "update_plan",
  "note",
]);

function isPlanAllowedTool(tool: ToolDef): boolean {
  if (tool.category === "shell") return false;
  if (tool.permission !== PermissionLevel.ALWAYS_ALLOW) return false;
  return PLAN_ALLOWED_TOOLS.has(tool.name);
}

export class PlanMode implements BaseMode {
  name = "plan";

  filterTools(tools: ToolDef[]): ToolDef[] {
    return tools.filter(isPlanAllowedTool);
  }

  async checkPermission(ctx: ApprovalContext, _callbacks?: UICallbacks): Promise<boolean> {
    if (ctx.tool_name !== ctx.tool_def.name) return false;
    return isPlanAllowedTool(ctx.tool_def);
  }
}

export class AgentMode implements BaseMode {
  name = "agent";

  filterTools(tools: ToolDef[]): ToolDef[] { return tools; }

  async checkPermission(ctx: ApprovalContext, callbacks?: UICallbacks): Promise<boolean> {
    if (ctx.tool_def.permission === "always_allow") return true;
    if (callbacks?.requestApproval) {
      return callbacks.requestApproval(
        ctx.tool_name, ctx.tool_args,
        `${ctx.tool_def.description}\n\nArguments: ${JSON.stringify(ctx.tool_args)}`,
      );
    }
    return false;
  }
}

export class YoloMode implements BaseMode {
  name = "yolo";

  filterTools(tools: ToolDef[]): ToolDef[] { return tools; }

  async checkPermission(ctx: ApprovalContext, callbacks?: UICallbacks): Promise<boolean> {
    if (ctx.tool_def.permission === "dangerous") {
      if (callbacks?.requestApproval) {
        return callbacks.requestApproval(
          ctx.tool_name, ctx.tool_args,
          `DANGEROUS: ${ctx.tool_def.description}`,
        );
      }
      return false;
    }
    return true;
  }
}

export function getMode(name: string): BaseMode {
  const modes: Record<string, BaseMode> = {
    plan: new PlanMode(),
    agent: new AgentMode(),
    yolo: new YoloMode(),
  };
  return modes[name] || new AgentMode();
}

export function nextModeName(name: string): ModeName {
  const current = MODE_NAMES.indexOf(name as ModeName);
  if (current === -1) return "agent";
  return MODE_NAMES[(current + 1) % MODE_NAMES.length];
}
