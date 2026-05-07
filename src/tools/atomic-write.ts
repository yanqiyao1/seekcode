/** Atomic text-file writes with best-effort permission preservation. */

import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function resolveWriteTarget(path: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return realpathSync(path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  return path;
}

export function writeTextFileAtomic(path: string, content: string, options: AtomicWriteOptions = {}): void {
  const encoding = options.encoding ?? "utf-8";
  const targetPath = resolveWriteTarget(path);
  mkdirSync(dirname(targetPath), { recursive: true });

  let targetExists = false;
  let targetMode: number | undefined;
  try {
    const stat = statSync(targetPath);
    targetExists = true;
    targetMode = stat.mode;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    targetMode = options.mode;
  }

  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  const writeOptions: { encoding: BufferEncoding; flush: boolean; mode?: number } = {
    encoding,
    flush: true,
  };
  if (!targetExists && targetMode !== undefined) writeOptions.mode = targetMode;

  try {
    writeFileSync(tempPath, content, writeOptions);
    if (targetExists && targetMode !== undefined) chmodSync(tempPath, targetMode);
    renameSync(tempPath, targetPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* ignore cleanup failures */ }
    writeFileSync(targetPath, content, writeOptions);
  }
}
