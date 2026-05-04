/** Tool discovery for deferred tools without sending every schema every turn. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

async function toolSearch(args: Record<string, unknown>): Promise<string> {
  const query = normalize(args.query || args.q);
  if (!query.trim()) return "Error: query is required.";
  const terms = query.split(/\s+/).filter(Boolean);
  const registry = getRegistry();
  const matches = registry.listAll()
    .map(tool => {
      const haystack = normalize(`${tool.name} ${tool.description} ${tool.category} ${JSON.stringify(tool.parameters)}`);
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { tool, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, 12);

  if (!matches.length) return `No tools matched '${query}'.`;
  for (const { tool } of matches) registry.activate(tool.name);
  return [
    `Activated ${matches.length} matching tool(s):`,
    ...matches.map(({ tool }) => `- ${tool.name}: ${tool.description}`),
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
  });
  getRegistry().register({
    name: "tool_stats",
    description: "Show tool call counts, failures, active state, and degradation reasons.",
    parameters: { type: "object", properties: {} },
    execute: toolStats,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
  });
  getRegistry().register({
    name: "tool_enable",
    description: "Re-enable a degraded or deferred tool by name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: toolEnable,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
  });
}
