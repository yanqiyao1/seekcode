/** Base tool definitions. */

export enum PermissionLevel {
  ALWAYS_ALLOW = "always_allow",
  ASK = "ask",
  DENY_IN_PLAN = "deny_in_plan",
  DANGEROUS = "dangerous",
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>;
  permission: PermissionLevel;
  category: string;
  parallelOk: boolean;
  deferLoading?: boolean;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export function toolToOpenAISchema(tool: ToolDef): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  is_error: boolean;
}

export interface ApprovalContext {
  tool_name: string;
  tool_args: Record<string, unknown>;
  tool_def: ToolDef;
  workspace_path: string;
}
