import { join, resolve } from "node:path";

export const SEEKCODE_DIR = ".seekcode";
export const LEGACY_DEEPSEEK_DIR = ".deepseek";
export const SEEKCODE_DATA_DIR = "seekcode";
export const LEGACY_DEEPSEEK_DATA_DIR = "deepseek";

export function homeDir(): string {
  return process.env.HOME || "~";
}

export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || resolve(homeDir(), ".local", "share");
}

export function seekcodeDataPath(...segments: string[]): string {
  return join(xdgDataHome(), SEEKCODE_DATA_DIR, ...segments);
}

export function legacyDeepseekDataPath(...segments: string[]): string {
  return join(xdgDataHome(), LEGACY_DEEPSEEK_DATA_DIR, ...segments);
}
