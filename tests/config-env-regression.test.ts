import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { explainConfig, loadConfig, validateConfig } from "../src/config.js";

let tmp: string;
let oldHome: string | undefined;
let oldCwd: string;
let oldEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "DEEPSEEK_MAX_TOKENS",
  "DEEPSEEK_MAX_TURNS",
  "DEEPSEEK_CONTEXT_LIMIT",
  "DEEPSEEK_THEME",
  "DEEPSEEK_ROLLBACK_ENABLED",
  "DEEPSEEK_COST_TRACKING",
  "DEEPSEEK_THINKING_VISIBLE",
  "DEEPSEEK_STATUS_ITEMS",
  "DEEPSEEK_WEB_SEARCH_ENGINE",
  "SEEKCODE_MAX_TURNS",
  "SEEKCODE_WEB_SEARCH_ENGINE",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-config-env-"));
  oldHome = process.env.HOME;
  oldCwd = process.cwd();
  oldEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.HOME = join(tmp, "home");
  mkdirSync(join(process.env.HOME, ".seekcode"), { recursive: true });
  process.chdir(tmp);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  for (const key of ENV_KEYS) {
    const value = oldEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("config env overrides", () => {
  it.each([
    ["max tokens", "DEEPSEEK_MAX_TOKENS", "1234", (cfg: ReturnType<typeof loadConfig>) => cfg.max_tokens, 1234],
    ["max turns", "DEEPSEEK_MAX_TURNS", "7", (cfg: ReturnType<typeof loadConfig>) => cfg.max_turns, 7],
    ["context limit", "DEEPSEEK_CONTEXT_LIMIT", "65536", (cfg: ReturnType<typeof loadConfig>) => cfg.context_limit, 65536],
    ["theme", "DEEPSEEK_THEME", "sunrise", (cfg: ReturnType<typeof loadConfig>) => cfg.theme, "sunrise"],
    ["rollback false", "DEEPSEEK_ROLLBACK_ENABLED", "false", (cfg: ReturnType<typeof loadConfig>) => cfg.rollback_enabled, false],
    ["rollback true", "DEEPSEEK_ROLLBACK_ENABLED", "true", (cfg: ReturnType<typeof loadConfig>) => cfg.rollback_enabled, true],
    ["cost tracking false", "DEEPSEEK_COST_TRACKING", "0", (cfg: ReturnType<typeof loadConfig>) => cfg.cost_tracking, false],
    ["cost tracking true", "DEEPSEEK_COST_TRACKING", "yes", (cfg: ReturnType<typeof loadConfig>) => cfg.cost_tracking, true],
    ["thinking visible false", "DEEPSEEK_THINKING_VISIBLE", "off", (cfg: ReturnType<typeof loadConfig>) => cfg.thinking_visible, false],
    ["thinking visible true", "DEEPSEEK_THINKING_VISIBLE", "on", (cfg: ReturnType<typeof loadConfig>) => cfg.thinking_visible, true],
  ])("loads %s from env", (_label, key, value, pick, expected) => {
    process.env[key] = value;

    const cfg = loadConfig();

    expect(pick(cfg)).toBe(expected);
  });

  it("parses comma-separated status items from env", () => {
    process.env.DEEPSEEK_STATUS_ITEMS = "mode, model ,workspace,hints";

    const cfg = loadConfig();

    expect(cfg.status_items).toEqual(["mode", "model", "workspace", "hints"]);
  });

  it("prefers canonical SEEKCODE env vars over legacy DEEPSEEK env vars", () => {
    process.env.DEEPSEEK_MAX_TURNS = "7";
    process.env.SEEKCODE_MAX_TURNS = "9";
    process.env.DEEPSEEK_WEB_SEARCH_ENGINE = "bing";
    process.env.SEEKCODE_WEB_SEARCH_ENGINE = "duckduckgo";

    const cfg = loadConfig();

    expect(cfg.max_turns).toBe(9);
    expect(cfg.web.search_engine).toBe("duckduckgo");
  });

  it("ignores invalid numeric env values and falls back to defaults", () => {
    process.env.DEEPSEEK_MAX_TURNS = "nope";
    process.env.DEEPSEEK_CONTEXT_LIMIT = "bad";

    const cfg = loadConfig();

    expect(cfg.max_turns).toBe(50);
    expect(cfg.context_limit).toBe(1_000_000);
  });

  it("reports env conflicts in explainConfig when cli overrides win", () => {
    process.env.DEEPSEEK_THEME = "ocean";
    process.env.DEEPSEEK_MAX_TURNS = "11";

    const explain = explainConfig({ theme: "forest", max_turns: 3 });

    expect(explain.conflicts.some(conflict => conflict.key === "theme" && conflict.winner === "cli")).toBe(true);
    expect(explain.conflicts.some(conflict => conflict.key === "max_turns" && conflict.winner === "cli")).toBe(true);
  });

  it("reports nested config conflicts such as web.search_engine", () => {
    process.env.DEEPSEEK_WEB_SEARCH_ENGINE = "bing";

    const explain = explainConfig({ web: { search_engine: "duckduckgo" } });

    expect(explain.conflicts.some(conflict => conflict.key === "web.search_engine" && conflict.winner === "cli")).toBe(true);
  });

  it("keeps config validation green for the added env-backed keys", () => {
    process.env.DEEPSEEK_MAX_TURNS = "4";
    process.env.DEEPSEEK_CONTEXT_LIMIT = "32768";
    process.env.DEEPSEEK_THEME = "paper";
    process.env.DEEPSEEK_ROLLBACK_ENABLED = "1";
    process.env.DEEPSEEK_COST_TRACKING = "1";
    process.env.DEEPSEEK_THINKING_VISIBLE = "0";

    const validation = validateConfig();

    expect(validation.ok).toBe(true);
    expect(validation.resolved).toMatchObject({
      max_turns: 4,
      context_limit: 32768,
      theme: "paper",
      rollback_enabled: true,
      cost_tracking: true,
      thinking_visible: false,
    });
  });
});
