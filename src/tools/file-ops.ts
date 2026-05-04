/** File operation tools: read, write, edit, ls, search, glob. */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { PermissionLevel, type ToolDef } from "./base.js";
import { getRegistry } from "./registry.js";
import { diffLines } from "../ui/renderer.js";

function resolvePath(path: string): string { return resolve(path); }

function resolveFromRoot(path: string, root: string): string {
  return resolve(path.startsWith("/") || /^[a-zA-Z]:/.test(path) ? path : join(root, path));
}

function workspaceRoot(args: Record<string, unknown>, fallbackPath?: string): string {
  const root = args.root || args.workspace || args.cwd || fallbackPath || process.cwd();
  return String(root);
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}

function resolveExistingPathInsideRoot(path: string, root: string): string {
  const resolvedRoot = realpathSync(resolvePath(root));
  const resolvedPath = realpathSync(resolveFromRoot(path, resolvedRoot));
  if (!isInsideRoot(resolvedPath, resolvedRoot)) {
    throw new Error(`path escapes root through symlink: ${path}`);
  }
  return resolvedPath;
}

function resolveWritablePathInsideRoot(path: string, root: string): string {
  const resolvedRoot = realpathSync(resolvePath(root));
  const target = resolveFromRoot(path, resolvedRoot);
  const nearestExisting = nearestExistingParent(target);
  const realParent = realpathSync(nearestExisting);
  if (!isInsideRoot(realParent, resolvedRoot)) {
    throw new Error(`path escapes root through symlink: ${path}`);
  }
  return target;
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}

async function readFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  const root = workspaceRoot(args);
  const offset = (args.offset as number) || 0;
  const limit = (args.limit as number) || 2000;
  try {
    const content = readFileSync(resolveExistingPathInsideRoot(path, String(root)), "utf-8");
    const lines = content.split("\n");
    return lines.slice(offset, offset + (limit || lines.length)).join("\n");
  } catch (e: any) { return `Error reading file: ${e.message}`; }
}

async function writeFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  const content = args.content as string;
  const root = workspaceRoot(args);
  try {
    const target = resolveWritablePathInsideRoot(path, String(root));
    const oldContent = existsSync(target) ? readFileSync(target, "utf-8") : "";
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf-8");
    return [
      `Successfully wrote ${content.length} bytes to ${path}`,
      "",
      "[diff]",
      diffLines(oldContent, content, path),
    ].join("\n");
  } catch (e: any) { return `Error writing file: ${e.message}`; }
}

async function editFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  const root = workspaceRoot(args);
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) || false;
  if (!oldString) return "Error: old_string must not be empty";
  try {
    const target = resolveExistingPathInsideRoot(path, String(root));
    const content = readFileSync(target, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${path}`;
    if (!replaceAll && count > 1) return `Error: old_string found ${count} times. Use replace_all=true or provide more context.`;
    const nextContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
    writeFileSync(target, nextContent, "utf-8");
    return [
      `Successfully edited ${path}`,
      "",
      "[diff]",
      diffLines(content, nextContent, path),
    ].join("\n");
  } catch (e: any) { return `Error editing file: ${e.message}`; }
}

async function ls(args: Record<string, unknown>): Promise<string> {
  const path = (args.path as string) || ".";
  const root = workspaceRoot(args, path);
  try {
    const dir = resolveExistingPathInsideRoot(path, root);
    const items = readdirSync(dir, { withFileTypes: true });
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines = items.slice(0, 200).map((item) => {
      const suffix = item.isDirectory() ? "/" : "";
      let size = "";
      if (item.isFile()) {
        try { size = ` (${statSync(join(dir, item.name)).size.toLocaleString()} bytes)`; } catch { /* */ }
      }
      return `  ${item.name}${suffix}${size}`;
    });
    return lines.join("\n") || "(empty directory)";
  } catch (e: any) { return `Error listing directory: ${e.message}`; }
}

async function search(args: Record<string, unknown>): Promise<string> {
  const pattern = args.pattern as string;
  const path = (args.path as string) || ".";
  const include = (args.include as string) || "";
  const caseSensitive = args.case_sensitive !== false;
  const boundary = workspaceRoot(args, path);
  try {
    const root = resolveExistingPathInsideRoot(path, boundary);
    const grepArgs = ["-rnF"];
    if (!caseSensitive) grepArgs.push("-i");
    grepArgs.push("--directories=recurse", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.deepseek");
    if (include) grepArgs.push(`--include=${include}`);
    grepArgs.push(pattern, root);
    const result = spawnSync("grep", grepArgs, { encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
    if (result.status === 1) return `No matches found for '${pattern}'`;
    if (result.error) return `Error searching: ${result.error.message}`;
    if (result.status && result.status !== 0) return `Error searching: ${result.stderr || `grep exited with ${result.status}`}`;
    return result.stdout.split("\n").filter(Boolean).slice(0, 500).join("\n") || `No matches found for '${pattern}'`;
  } catch (e: any) {
    if (e.code === 1 || e.status === 1) return `No matches found for '${pattern}'`;
    return `Error searching: ${e.message}`;
  }
}

async function glob(args: Record<string, unknown>): Promise<string> {
  const pattern = args.pattern as string;
  const path = (args.path as string) || ".";
  const boundary = workspaceRoot(args, path);
  try {
    const results: string[] = [];
    const root = resolveExistingPathInsideRoot(path, boundary);
    const matcher = globToRegExp(pattern);
    function walk(dir: string) {
      try {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, item.name);
          let realFull: string;
          try { realFull = realpathSync(full); }
          catch { continue; }
          if (!isInsideRoot(realFull, root)) continue;
          const rel = relative(root, full).replace(/\\/g, "/");
          if (item.isDirectory()) {
            if (!item.name.startsWith(".") && item.name !== "node_modules") walk(full);
            continue;
          }
          if (matcher.test(rel)) results.push(full);
        }
      } catch { /* */ }
    }
    walk(root);
    if (!results.length) return `No files matching '${pattern}'`;
    return results.slice(0, 200).map(m => `  ${relative(root, m).replace(/\\/g, "/")}`).join("\n");
  } catch (e: any) { return `Error in glob: ${e.message}`; }
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const followedBySlash = pattern[i + 2] === "/";
        out += followedBySlash ? "(?:.*\/)?" : ".*";
        i += followedBySlash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

export function registerFileTools(): void {
  const r = getRegistry();
  const t = (
    name: string, desc: string, props: Record<string, unknown>, required: string[],
    fn: (a: Record<string, unknown>) => Promise<string>, perm: PermissionLevel, cat: string, pok: boolean,
  ) => r.register({
    name, description: desc,
    parameters: { type: "object", properties: props, required },
    execute: fn, permission: perm, category: cat, parallelOk: pok,
  });
  t("read", "Read a file from the filesystem.", { path: { type: "string" }, root: { type: "string", description: "Optional root boundary for symlink safety." }, offset: { type: "integer", default: 0 }, limit: { type: "integer", default: 2000 } }, ["path"], readFile, PermissionLevel.ALWAYS_ALLOW, "file", true);
  t("write", "Write content to a file.", { path: { type: "string" }, content: { type: "string" }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, ["path", "content"], writeFile, PermissionLevel.ASK, "file", false);
  t("edit", "Edit a file by replacing old_string with new_string.", { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean", default: false }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, ["path", "old_string", "new_string"], editFile, PermissionLevel.ASK, "file", false);
  t("ls", "List directory contents.", { path: { type: "string", default: "." }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, [], ls, PermissionLevel.ALWAYS_ALLOW, "file", true);
  t("search", "Search for text using grep.", { pattern: { type: "string" }, path: { type: "string", default: "." }, root: { type: "string", description: "Optional root boundary for symlink safety." }, include: { type: "string", default: "" }, case_sensitive: { type: "boolean", default: true } }, ["pattern"], search, PermissionLevel.ALWAYS_ALLOW, "file", true);
  t("glob", "Find files matching a glob pattern.", { pattern: { type: "string" }, path: { type: "string", default: "." }, root: { type: "string", description: "Optional root boundary for symlink safety." } }, ["pattern"], glob, PermissionLevel.ALWAYS_ALLOW, "file", true);
}
