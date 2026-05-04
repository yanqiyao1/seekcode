/** RLM tool — fan-out parallel queries to flash model. */

import OpenAI from "openai";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

interface RLMQuery { id: string; prompt: string; system?: string; }

async function rlmQuery(args: Record<string, unknown>): Promise<string> {
  const promptsStr = args.prompts as string;
  const maxChildren = Math.max(1, Math.min((args.max_children as number) || 8, 16));
  let queries: RLMQuery[];
  try { queries = JSON.parse(promptsStr); } catch { return "Error: prompts must be valid JSON array"; }
  if (!Array.isArray(queries)) return "Error: prompts must be a JSON array";
  queries = queries.slice(0, 16);

  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const flashModel = process.env.DEEPSEEK_FLASH_MODEL || "deepseek-chat";
  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  const runOne = async (q: RLMQuery) => {
    try {
      const resp = await client.chat.completions.create({
        model: flashModel, max_tokens: 2048,
        messages: [{ role: "system", content: q.system || "You are a helpful assistant." }, { role: "user", content: q.prompt }],
      });
      return { id: q.id, result: resp.choices[0]?.message?.content || "", error: null };
    } catch (e: any) { return { id: q.id, result: null, error: e.message }; }
  };

  const results = await Promise.all(queries.map(runOne));
  return JSON.stringify(results, null, 2);
}

export function registerRLMTool(): void {
  getRegistry().register({
    name: "rlm_query", description: "Fan out parallel reasoning queries (1-16 children) to a fast model.",
    parameters: { type: "object", properties: { prompts: { type: "string", description: "JSON array of {id, prompt, system?}" }, max_children: { type: "integer", default: 8 } }, required: ["prompts"] },
    execute: rlmQuery, permission: PermissionLevel.ALWAYS_ALLOW, category: "meta", parallelOk: true,
  });
}
