/** Tool discovery for deferred tools without sending every schema every turn. */

import { PermissionLevel, isToolConcurrencySafe, isToolDestructive, isToolReadOnly } from "./base.js";
import { getRegistry } from "./registry.js";

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

async function toolSearch(args: Record<string, unknown>): Promise<string> {
  const query = normalize(args.query || args.q);
  if (!query.trim()) return "Error: query is required.";
  const registry = getRegistry();
  const matches = registry.search(query, 12);

  if (!matches.length) return `No tools matched '${query}'.`;
  for (const { tool } of matches) registry.activate(tool.name);
  return [
    `Activated ${matches.length} matching tool(s):`,
    ...matches.map(({ tool }) => {
      const tags = [
        isToolReadOnly(tool) ? "read-only" : "",
        isToolDestructive(tool) ? "destructive" : "",
        isToolConcurrencySafe(tool) ? "concurrent" : "",
        tool.searchHint ? `hint: ${tool.searchHint}` : "",
      ].filter(Boolean).join(", ");
      return `- ${tool.name}${tags ? ` [${tags}]` : ""}: ${tool.description}`;
    }),
  ].join("\n");
}

async function toolStats(): Promise<string> {
  return JSON.stringify(getRegistry().toolStats(), null, 2);
}

async function toolEnable(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name || "");
  if (!name) return "Error: name is required.";
  return getRegistry().enableDegraded(name) ? `Enabled ${name}.` : `Error: tool not found: ${name}`;
}

export function registerToolSearchTool(): void {
  getRegistry().register({
    name: "tool_search",
    description: "Search and activate deferred tool definitions by name, description, category, or schema.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Tool capability to search for." },
      },
      required: ["query"],
    },
    execute: toolSearch,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
    searchHint: "discover deferred tools",
    resultKind: "text",
  });
  getRegistry().register({
    name: "tool_stats",
    description: "Show tool call counts, failures, active state, and degradation reasons.",
    parameters: { type: "object", properties: {} },
    execute: toolStats,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
    searchHint: "inspect tool health",
    resultKind: "json",
  });
  getRegistry().register({
    name: "tool_enable",
    description: "Re-enable a degraded or deferred tool by name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: toolEnable,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    searchHint: "reenable tool",
    resultKind: "text",
  });
}
