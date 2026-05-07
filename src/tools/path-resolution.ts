import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function nearestExistingParent(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}

export function canonicalizePath(path: string): string {
  return realpathSync(resolve(path));
}

export function canonicalizePathOrNearestExisting(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync(resolved);
  let current = resolved;
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    missingSegments.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return resolve(realpathSync(current), ...missingSegments);
}

export function resolvePathFromBase(rawPath: string, base: string): string {
  return resolve(isAbsolute(rawPath) ? rawPath : resolve(base, rawPath));
}

export function resolvePathAlias(rawPath: string, base: string): string {
  return resolvePathFromBase(rawPath.trim(), base);
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}

export function canonicalizeWorkspaceBoundary(path: string, workspace: string): boolean {
  return isPathInsideRoot(
    canonicalizePathOrNearestExisting(path),
    canonicalizePathOrNearestExisting(workspace),
  );
}
