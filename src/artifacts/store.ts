/** Unified artifact store for large logs, patches, diagnostics, and external evidence. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { seekcodeDataPath } from "../paths.js";

export interface ArtifactRecord {
  id: string;
  kind: string;
  name: string;
  path: string;
  metadataPath: string;
  bytes: number;
  sha256: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface CreateArtifactOptions {
  kind: string;
  name: string;
  content: string | Buffer;
  metadata?: Record<string, unknown>;
  extension?: string;
}

export interface ArtifactLink {
  artifact_id: string;
  scope: "session" | "turn" | "task" | "job";
  target_id: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export function createArtifact(options: CreateArtifactOptions): ArtifactRecord {
  const root = artifactRoot();
  mkdirSync(root, { recursive: true });
  const createdAt = new Date().toISOString();
  const content = typeof options.content === "string" ? Buffer.from(options.content, "utf-8") : options.content;
  const sha256 = createHash("sha256").update(content).digest("hex");
  const id = `${safeId(options.kind)}_${Date.now().toString(36)}_${sha256.slice(0, 10)}`;
  const extension = safeExtension(options.extension || extname(options.name) || ".txt");
  const path = join(root, `${id}${extension}`);
  const metadataPath = join(root, `${id}.json`);
  const record: ArtifactRecord = {
    id,
    kind: options.kind,
    name: basename(options.name || id),
    path,
    metadataPath,
    bytes: content.byteLength,
    sha256,
    created_at: createdAt,
    metadata: options.metadata || {},
  };
  writeFileSync(path, content);
  writeFileSync(metadataPath, JSON.stringify(record, null, 2), "utf-8");
  return record;
}

export function listArtifacts(limit = 50, kind?: string): ArtifactRecord[] {
  const root = artifactRoot();
  if (!existsSync(root)) return [];
  const records: ArtifactRecord[] = [];
  for (const file of readdirSync(root).filter(name => name.endsWith(".json"))) {
    try {
      const record = JSON.parse(readFileSync(join(root, file), "utf-8")) as ArtifactRecord;
      if (!isArtifactRecord(record)) continue;
      if (kind && record.kind !== kind) continue;
      records.push(record);
    } catch {
      // skip corrupt metadata
    }
  }
  return records
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

export function getArtifact(id: string): ArtifactRecord | undefined {
  return listArtifacts(500).find(record => record.id === id);
}

export function readArtifact(id: string, maxBytes = 200_000): string {
  const record = getArtifact(id);
  if (!record) return `Error: artifact not found: ${id}`;
  try {
    const stats = statSync(record.path);
    const content = readFileSync(record.path);
    const truncated = content.byteLength > maxBytes;
    const slice = truncated ? content.subarray(0, maxBytes) : content;
    return [
      JSON.stringify({ ...record, truncated, total_bytes: stats.size }, null, 2),
      "",
      slice.toString("utf-8"),
    ].join("\n");
  } catch (e: any) {
    return `Error reading artifact ${id}: ${e.message}`;
  }
}

export function linkArtifact(
  artifactId: string,
  scope: ArtifactLink["scope"],
  targetId: string,
  metadata: Record<string, unknown> = {},
): ArtifactLink {
  const link: ArtifactLink = {
    artifact_id: artifactId,
    scope,
    target_id: targetId,
    created_at: new Date().toISOString(),
    metadata,
  };
  const links = listArtifactLinks();
  if (!links.some(item => item.artifact_id === artifactId && item.scope === scope && item.target_id === targetId)) {
    links.push(link);
    writeArtifactLinks(links);
  }
  return link;
}

export function listArtifactLinks(filter: Partial<Pick<ArtifactLink, "scope" | "target_id" | "artifact_id">> = {}): ArtifactLink[] {
  try {
    const links = JSON.parse(readFileSync(artifactIndexPath(), "utf-8")) as ArtifactLink[];
    return links.filter(link => {
      if (filter.scope && link.scope !== filter.scope) return false;
      if (filter.target_id && link.target_id !== filter.target_id) return false;
      if (filter.artifact_id && link.artifact_id !== filter.artifact_id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

export function artifactRoot(): string {
  if (process.env.SEEKCODE_ARTIFACTS_DIR) return resolve(process.env.SEEKCODE_ARTIFACTS_DIR);
  if (process.env.DEEPCODE_ARTIFACTS_DIR) return resolve(process.env.DEEPCODE_ARTIFACTS_DIR);
  if (process.env.DEEPSEEK_ARTIFACTS_DIR) return resolve(process.env.DEEPSEEK_ARTIFACTS_DIR);
  return seekcodeDataPath("artifacts");
}

export function clearArtifactsForTests(): void {
  try { rmSync(artifactRoot(), { recursive: true, force: true }); } catch { /* ignore */ }
}

function artifactIndexPath(): string {
  return join(artifactRoot(), "index.json");
}

function writeArtifactLinks(links: ArtifactLink[]): void {
  mkdirSync(artifactRoot(), { recursive: true });
  writeFileSync(artifactIndexPath(), JSON.stringify(links, null, 2), "utf-8");
}

function safeId(value: string): string {
  return String(value || "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48) || "artifact";
}

function safeExtension(value: string): string {
  const extension = value.startsWith(".") ? value : `.${value}`;
  return extension.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 16) || ".txt";
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ArtifactRecord>;
  return typeof record.id === "string"
    && typeof record.kind === "string"
    && typeof record.path === "string"
    && typeof record.metadataPath === "string"
    && typeof record.created_at === "string"
    && typeof record.sha256 === "string"
    && typeof record.bytes === "number";
}
