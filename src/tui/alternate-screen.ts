import type { Config } from "../config.js";

export type AlternateScreenMode = Config["tui_alternate_screen"];

export function shouldUseAlternateScreen(mode: AlternateScreenMode, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return !env.ZELLIJ;
}
