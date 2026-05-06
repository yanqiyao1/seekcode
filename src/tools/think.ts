/** Think tool — explicit reasoning step. */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

async function think(args: Record<string, unknown>): Promise<string> {
  const thought = args.thought as string;
  const preview = thought.length > 200 ? thought.slice(0, 200) + "..." : thought;
  return `Thought recorded: ${preview}`;
}

export function registerThinkTool(): void {
  getRegistry().register({
    name: "think", description: "Think through a complex problem step by step.",
    parameters: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
    execute: think, permission: PermissionLevel.ALWAYS_ALLOW, category: "meta", parallelOk: true,
    readOnly: true,
    searchHint: "scratch reasoning note",
    resultKind: "text",
  });
}
