/** Global tool registry singleton. */

import type { ToolDef } from "./base.js";
import { toolToOpenAISchema } from "./base.js";

const ALWAYS_ACTIVE_TOOLS = new Set([
  "read",
  "ls",
  "search",
  "glob",
  "diagnostics",
  "tool_search",
  "tool_stats",
  "tool_enable",
  "rlm_query",
  "think",
  "get_goal",
  "plan_status",
  "checklist_write",
  "update_plan",
  "note",
  "task_create",
  "task_list",
  "task_read",
  "task_cancel",
  "task_complete",
  "task_fail",
  "task_shell_start",
  "task_shell_wait",
  "exec_shell_wait",
  "exec_shell_cancel",
  "artifact_create",
  "artifact_list",
  "artifact_read",
  "mcp_manager",
  "lsp_diagnostics",
]);

export class ToolRegistry {
  private static instance: ToolRegistry;
  private tools: Map<string, ToolDef> = new Map();
  private schemaCache: Record<string, unknown>[] | null = null;
  private activeToolNames: Set<string> = new Set();
  private stats: Map<string, ToolStats> = new Map();
  private disabledReasons: Map<string, string> = new Map();

  static get(): ToolRegistry {
    if (!ToolRegistry.instance) ToolRegistry.instance = new ToolRegistry();
    return ToolRegistry.instance;
  }

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
    if (!tool.deferLoading || ALWAYS_ACTIVE_TOOLS.has(tool.name)) {
      this.activeToolNames.add(tool.name);
    }
    this.schemaCache = null;
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.activeToolNames.delete(name);
    this.stats.delete(name);
    this.disabledReasons.delete(name);
    this.schemaCache = null;
  }

  lookup(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  listAll(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listActive(): ToolDef[] {
    return this.listAll().filter(tool => this.activeToolNames.has(tool.name));
  }

  activate(name: string): boolean {
    if (!this.tools.has(name)) return false;
    if (this.disabledReasons.has(name)) return false;
    const before = this.activeToolNames.size;
    this.activeToolNames.add(name);
    if (this.activeToolNames.size !== before) this.schemaCache = null;
    return true;
  }

  deactivate(name: string): boolean {
    if (!this.activeToolNames.delete(name)) return false;
    this.schemaCache = null;
    return true;
  }

  activateForContext(text: string): string[] {
    const normalized = text.toLowerCase();
    const activated: string[] = [];
    for (const tool of this.listAll()) {
      if (this.activeToolNames.has(tool.name) || this.disabledReasons.has(tool.name)) continue;
      const haystack = `${tool.name} ${tool.description} ${tool.category}`.toLowerCase();
      if (!haystack.split(/[_\s-]+/).some(term => term.length >= 4 && normalized.includes(term))) continue;
      if (this.activate(tool.name)) activated.push(tool.name);
    }
    return activated.slice(0, 8);
  }

  recordCall(name: string, ok: boolean, durationMs: number): ToolStats {
    const current = this.stats.get(name) || {
      name,
      calls: 0,
      failures: 0,
      consecutive_failures: 0,
      total_ms: 0,
      last_called_at: "",
    };
    current.calls++;
    current.total_ms += Math.max(0, durationMs);
    current.last_called_at = new Date().toISOString();
    if (ok) {
      current.consecutive_failures = 0;
    } else {
      current.failures++;
      current.consecutive_failures++;
    }
    this.stats.set(name, current);
    return current;
  }

  degradeIfUnhealthy(name: string, threshold: number): string | null {
    const stats = this.stats.get(name);
    if (!stats || stats.consecutive_failures < Math.max(1, threshold)) return null;
    const reason = `disabled after ${stats.consecutive_failures} consecutive failures`;
    this.disabledReasons.set(name, reason);
    this.deactivate(name);
    return reason;
  }

  enableDegraded(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.disabledReasons.delete(name);
    return this.activate(name);
  }

  toolStats(): Array<ToolStats & { active: boolean; disabled_reason?: string }> {
    return this.listAll().map(tool => ({
      ...(this.stats.get(tool.name) || {
        name: tool.name,
        calls: 0,
        failures: 0,
        consecutive_failures: 0,
        total_ms: 0,
        last_called_at: "",
      }),
      active: this.activeToolNames.has(tool.name),
      disabled_reason: this.disabledReasons.get(tool.name),
    }));
  }

  toOpenAISchemas(options: { activeOnly?: boolean } = {}): Record<string, unknown>[] {
    if (!options.activeOnly && this.schemaCache) return this.schemaCache;
    const tools = options.activeOnly ? this.listActive() : this.listAll();
    const schemas = tools.map(toolToOpenAISchema);
    if (!options.activeOnly) this.schemaCache = schemas;
    return schemas;
  }

  clear(): void {
    this.tools.clear();
    this.activeToolNames.clear();
    this.stats.clear();
    this.disabledReasons.clear();
    this.schemaCache = null;
  }

  get size(): number {
    return this.tools.size;
  }

  get activeSize(): number {
    return this.activeToolNames.size;
  }
}

export interface ToolStats {
  name: string;
  calls: number;
  failures: number;
  consecutive_failures: number;
  total_ms: number;
  last_called_at: string;
}

export function getRegistry(): ToolRegistry {
  return ToolRegistry.get();
}
