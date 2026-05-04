/** Tools for unified artifact storage. */

import { createArtifact, linkArtifact, listArtifactLinks, listArtifacts, readArtifact } from "../artifacts/store.js";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

async function artifactCreate(args: Record<string, unknown>): Promise<string> {
  const content = String(args.content ?? "");
  if (!content) return "Error: content is required.";
  const record = createArtifact({
    kind: String(args.kind || "generic"),
    name: String(args.name || "artifact.txt"),
    content,
    extension: args.extension ? String(args.extension) : undefined,
    metadata: typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : {},
  });
  return JSON.stringify(record, null, 2);
}

async function artifactList(args: Record<string, unknown>): Promise<string> {
  const limit = Number(args.limit || 50);
  const kind = args.kind ? String(args.kind) : undefined;
  const records = listArtifacts(limit, kind);
  return records.length ? JSON.stringify(records, null, 2) : "No artifacts.";
}

async function artifactRead(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || "");
  if (!id) return "Error: id is required.";
  return readArtifact(id, Number(args.max_bytes || 200_000));
}

async function artifactLink(args: Record<string, unknown>): Promise<string> {
  const id = String(args.id || args.artifact_id || "");
  const scope = String(args.scope || "session") as "session" | "turn" | "task" | "job";
  const target = String(args.target_id || args.target || "");
  if (!id || !target) return "Error: id and target_id are required.";
  return JSON.stringify(linkArtifact(id, scope, target, typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : {}), null, 2);
}

async function artifactLinks(args: Record<string, unknown>): Promise<string> {
  const links = listArtifactLinks({
    scope: args.scope ? String(args.scope) as any : undefined,
    target_id: args.target_id ? String(args.target_id) : undefined,
    artifact_id: args.id ? String(args.id) : undefined,
  });
  return links.length ? JSON.stringify(links, null, 2) : "No artifact links.";
}

export function registerArtifactTools(): void {
  const registry = getRegistry();
  registry.register({
    name: "artifact_create",
    description: "Store a large log, patch, diagnostic result, or evidence file in the artifact store.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", default: "generic" },
        name: { type: "string", default: "artifact.txt" },
        content: { type: "string" },
        extension: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["content"],
    },
    execute: artifactCreate,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
  });
  registry.register({
    name: "artifact_list",
    description: "List stored artifacts.",
    parameters: { type: "object", properties: { limit: { type: "integer", default: 50 }, kind: { type: "string" } } },
    execute: artifactList,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
  });
  registry.register({
    name: "artifact_read",
    description: "Read an artifact by id, with optional byte limit.",
    parameters: { type: "object", properties: { id: { type: "string" }, max_bytes: { type: "integer", default: 200000 } }, required: ["id"] },
    execute: artifactRead,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
  });
  registry.register({
    name: "artifact_link",
    description: "Link an artifact to a session, turn, task, or job for later replay and evidence lookup.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        scope: { type: "string", enum: ["session", "turn", "task", "job"] },
        target_id: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["id", "scope", "target_id"],
    },
    execute: artifactLink,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
  });
  registry.register({
    name: "artifact_links",
    description: "List artifact links by scope, target_id, or artifact id.",
    parameters: { type: "object", properties: { scope: { type: "string" }, target_id: { type: "string" }, id: { type: "string" } } },
    execute: artifactLinks,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
  });
}
