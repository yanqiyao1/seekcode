import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { handleSlashCommand, isLiveReadonlyCommand, type SlashCommandRuntime } from "../src/commands/registry.js";
import type { Config } from "../src/config.js";
import { CostTracker } from "../src/cost/tracker.js";
import { ConversationHistory } from "../src/session/history.js";
import { createSession, type Session } from "../src/session/types.js";
import { commandCompletionProvider } from "../src/ui/input.js";

describe("slash command registry", () => {
  it("identifies commands that are safe while a turn is running", () => {
    expect(isLiveReadonlyCommand("/tokens")).toBe(true);
    expect(isLiveReadonlyCommand("/model")).toBe(false);
    expect(isLiveReadonlyCommand("plain request")).toBe(false);
  });

  it("dispatches mode and model commands through extracted handlers", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const history = new ConversationHistory(session);
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);

    await expect(handleSlashCommand("/plan", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(true);
    expect(cfg.mode).toBe("plan");
    expect(session.mode).toBe("plan");
    expect(runtime.rebuilds).toEqual({ runtime: 1, system: 1 });

    await expect(handleSlashCommand("/model deepseek-v4-flash", cfg, session, history, new CostTracker(cfg.model), runtime)).resolves.toBe(false);
    expect(cfg.model).toBe("deepseek-v4-flash");
    expect(session.model).toBe("deepseek-v4-flash");
    expect(writes.join("\n")).toContain("Model: deepseek-v4-flash");
  });

  it("gates mutating commands in live readonly mode before dispatch", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];
    const runtime = testRuntime(session, writes);
    runtime.liveReadonly = true;

    await expect(handleSlashCommand("/model deepseek-v4-flash", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), runtime)).resolves.toBe(false);

    expect(cfg.model).toBe("deepseek-v4-pro");
    expect(writes.join("\n")).toContain("not available while the agent is running");
  });

  it("reports unknown commands without mutating state", async () => {
    const cfg = testConfig();
    const session = createSession({ mode: cfg.mode, model: cfg.model });
    const writes: string[] = [];

    await expect(handleSlashCommand("/does-not-exist", cfg, session, new ConversationHistory(session), new CostTracker(cfg.model), testRuntime(session, writes))).resolves.toBe(false);

    expect(writes.join("\n")).toContain("Unknown command: /does-not-exist");
    expect(cfg.mode).toBe("agent");
  });

  it("expands Claude-compatible markdown slash commands into prompts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-command-"));
    try {
      mkdirSync(join(tmp, ".claude", "commands", "review"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "commands", "review", "security.md"), [
        "---",
        "description: Security review a target",
        "arguments: target",
        "---",
        "Review $target for security issues.",
        "Raw args: $ARGUMENTS",
      ].join("\n"));
      const cfg = testConfig();
      const session = createSession({ mode: cfg.mode, model: cfg.model, workspace_path: tmp });
      const result = await handleSlashCommand(
        "/project:review:security src/auth.ts",
        cfg,
        session,
        new ConversationHistory(session),
        new CostTracker(cfg.model),
        testRuntime(session, []),
      );

      expect(result).toMatchObject({ type: "prompt", label: "/project:review:security" });
      expect(typeof result === "object" && result.input).toContain("Review src/auth.ts for security issues.");
      expect(typeof result === "object" && result.input).toContain("Source:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes Claude-compatible commands in slash completion", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seek-code-claude-complete-"));
    try {
      mkdirSync(join(tmp, ".claude", "commands"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "commands", "verify.md"), [
        "---",
        "description: Run project verification",
        "---",
        "Run verification for $ARGUMENTS",
      ].join("\n"));

      const completions = commandCompletionProvider("/project:v", tmp);

      expect(completions.some(item => item.completeText === "/project:verify")).toBe(true);
      expect(completions.map(item => item.display).join("\n")).toContain("Run project verification");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function testRuntime(session: Session, writes: string[]): SlashCommandRuntime & { rebuilds: { runtime: number; system: number } } {
  const rebuilds = { runtime: 0, system: 0 };
  return {
    rebuilds,
    write(message: unknown) {
      writes.push(typeof message === "string" ? message : JSON.stringify(message));
    },
    applyLoadedSession(loaded) {
      Object.assign(session, loaded);
    },
    rebuildRuntime() {
      rebuilds.runtime++;
    },
    rebuildSystemPrompt() {
      rebuilds.system++;
    },
    renderLoadedSession() {},
  };
}

function testConfig(): Config {
  return {
    api_key: "test-key",
    provider: "deepseek",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    flash_model: "deepseek-v4-flash",
    mode: "agent",
    max_tokens: 8192,
    max_turns: 50,
    context_limit: 1_000_000,
    reasoning_effort: "high",
    rollback_enabled: true,
    cost_tracking: true,
    thinking_visible: true,
    tui_alternate_screen: "never",
    mcp_servers: [],
    skills_dir: "/tmp/seekcode-skills",
    skills_registry_url: "https://example.invalid/skills.json",
    skills_max_install_size_bytes: 1024,
    theme: "deepseek-dark",
    context_refresh_enabled: true,
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    workspace_boundary: true,
    trusted_workspaces: [],
    lsp_auto_diagnostics: false,
    lsp_diagnostics_severity: "warning",
    tool_call_budget_per_turn: 80,
    tool_failure_degrade_threshold: 3,
    status_items: ["mode", "model", "workspace"],
    web: {
      enabled: true,
      mode: "live",
      search_engine: "auto",
      allowed_domains: [],
      blocked_domains: [],
      google_api_key: "",
      google_cx: "",
      exa_api_key: "",
      kagi_api_key: "",
      brave_api_key: "",
      tavily_api_key: "",
      serper_api_key: "",
      semantic_scholar_api_key: "",
      pubmed_api_key: "",
      searxng_url: "",
      proxy: "",
      no_proxy: [],
      search_timeout_ms: 15_000,
      fetch_timeout_ms: 15_000,
      max_bytes: 1_000_000,
    },
  };
}
