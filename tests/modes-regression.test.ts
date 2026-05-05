import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { explainConfig, loadConfig, migrateProjectConfig, validateConfig } from "../src/config.js";
import { getMode } from "../src/modes/base.js";
import { checkApprovalCache, clearApprovalCache, DenialReason, getApprovalCache } from "../src/tools/approval-cache.js";
import { PermissionLevel, type ApprovalContext, type ToolDef } from "../src/tools/base.js";
import { checkSandboxPolicy, isTrustedWorkspace } from "../src/tools/sandbox.js";

let tmp: string;
let oldHome: string | undefined;
let oldCwd: string;
let oldEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-round7-"));
  oldHome = process.env.HOME;
  oldCwd = process.cwd();
  oldEnv = snapshotEnv([
    "DEEPSEEK_MODEL",
    "DEEPSEEK_MAX_TOKENS",
    "DEEPSEEK_WEB_SEARCH_ENGINE",
    "DEEPSEEK_WEB_ALLOWED_DOMAINS",
    "DEEPSEEK_WEB_BLOCKED_DOMAINS",
    "DEEPSEEK_WEB_GOOGLE_API_KEY",
    "DEEPSEEK_WEB_GOOGLE_CX",
    "DEEPSEEK_WEB_BRAVE_API_KEY",
    "DEEPSEEK_WEB_TAVILY_API_KEY",
    "DEEPSEEK_WEB_SERPER_API_KEY",
    "DEEPSEEK_WEB_SEARXNG_URL",
    "DEEPSEEK_WEB_PROXY",
    "DEEPSEEK_APPROVAL_POLICY",
    "DEEPSEEK_SANDBOX_MODE",
    "DEEPSEEK_WORKSPACE_BOUNDARY",
    "DEEPSEEK_TRUSTED_WORKSPACES",
  ]);
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  clearApprovalCache();
});

afterEach(() => {
  clearApprovalCache();
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  restoreEnv(oldEnv);
  rmSync(tmp, { recursive: true, force: true });
});

function tool(
  name: string,
  permission: PermissionLevel,
  category = "test",
): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    permission,
    category,
    parallelOk: true,
    execute: async () => `${name} ran`,
  };
}

function ctx(
  toolDef: ToolDef,
  toolName = toolDef.name,
  args: Record<string, unknown> = {},
  workspacePath = "/tmp/workspace",
): ApprovalContext {
  return {
    tool_name: toolName,
    tool_args: args,
    tool_def: toolDef,
    workspace_path: workspacePath,
  };
}

describe("interaction modes", () => {
  it("falls back to agent mode for unknown mode names", () => {
    expect(getMode("unknown").name).toBe("agent");
  });

  it("keeps plan mode limited to read/planning tools", async () => {
    const mode = getMode("plan");
    const tools = [
      tool("read", PermissionLevel.ALWAYS_ALLOW, "file"),
      tool("update_plan", PermissionLevel.ALWAYS_ALLOW, "meta"),
      tool("write", PermissionLevel.ASK, "file"),
      tool("bash", PermissionLevel.ASK, "shell"),
      tool("apply_patch", PermissionLevel.ASK, "file"),
      tool("spawn_agent", PermissionLevel.ALWAYS_ALLOW, "meta"),
      tool("custom_read", PermissionLevel.ALWAYS_ALLOW, "file"),
      tool("danger", PermissionLevel.DANGEROUS, "test"),
      tool("deny_plan", PermissionLevel.DENY_IN_PLAN, "test"),
    ];

    expect(mode.filterTools(tools).map(t => t.name)).toEqual(["read", "update_plan"]);
    await expect(mode.checkPermission(ctx(tools[0]!))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(tools[1]!))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(tools[2]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[3]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[4]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[5]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[6]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[7]!))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(tools[8]!))).resolves.toBe(false);
  });

  it("rejects mismatched plan tool definitions", async () => {
    const mode = getMode("plan");
    const readTool = tool("read", PermissionLevel.ALWAYS_ALLOW, "file");

    await expect(mode.checkPermission(ctx(readTool, "write"))).resolves.toBe(false);
  });

  it("asks in agent mode unless the tool is always allowed", async () => {
    const mode = getMode("agent");
    const safeTool = tool("read", PermissionLevel.ALWAYS_ALLOW, "file");
    const askTool = tool("write", PermissionLevel.ASK, "file");
    const requestApproval = vi.fn(async () => true);

    await expect(mode.checkPermission(ctx(safeTool))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(askTool))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(askTool), { requestApproval })).resolves.toBe(true);
    expect(requestApproval).toHaveBeenCalledWith("write", {}, expect.stringContaining("write tool"));
  });

  it("auto-approves yolo mode except dangerous tools", async () => {
    const mode = getMode("yolo");
    const askTool = tool("write", PermissionLevel.ASK, "file");
    const dangerousTool = tool("danger", PermissionLevel.DANGEROUS, "test");
    const requestApproval = vi.fn(async () => false);

    await expect(mode.checkPermission(ctx(askTool))).resolves.toBe(true);
    await expect(mode.checkPermission(ctx(dangerousTool))).resolves.toBe(false);
    await expect(mode.checkPermission(ctx(dangerousTool), { requestApproval })).resolves.toBe(false);
    expect(requestApproval).toHaveBeenCalledWith("danger", {}, expect.stringContaining("DANGEROUS"));
  });

  it("keeps plan mode restricted to explicit read-only tools", () => {
    const mode = getMode("plan");
    const tools = [
      tool("web_search", PermissionLevel.ALWAYS_ALLOW, "web"),
      tool("artifact_read", PermissionLevel.ALWAYS_ALLOW, "artifact"),
      tool("artifact_create", PermissionLevel.ALWAYS_ALLOW, "artifact"),
      tool("task_create", PermissionLevel.ALWAYS_ALLOW, "task"),
      tool("exec_shell_wait", PermissionLevel.ALWAYS_ALLOW, "shell"),
    ];

    expect(mode.filterTools(tools).map(item => item.name)).toEqual(["web_search"]);
  });
});

describe("config precedence and migration", () => {
  it("deep-merges user, project, env, and CLI config layers", () => {
    const userDir = join(process.env.HOME!, ".config", "deepseek");
    const projectDir = join(tmp, ".deepseek");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), [
      'model = "deepseek-v4-flash"',
      "[web]",
      'search_engine = "duckduckgo"',
      'allowed_domains = ["user.example"]',
      'proxy = "http://user.proxy:8080"',
      "",
    ].join("\n"));
    writeFileSync(join(projectDir, "config.toml"), [
      'model = "deepseek-v4-pro"',
      "[web]",
      'blocked_domains = ["project-block.example"]',
      "fetch_timeout_ms = 2200",
      "",
    ].join("\n"));
    process.env.DEEPSEEK_WEB_ALLOWED_DOMAINS = "env.example";
    process.env.DEEPSEEK_WEB_GOOGLE_API_KEY = "env-google";
    process.env.DEEPSEEK_WEB_GOOGLE_CX = "env-cx";
    process.env.DEEPSEEK_WEB_BRAVE_API_KEY = "env-brave";
    process.env.DEEPSEEK_WEB_SEARXNG_URL = "https://env-search.example";
    process.env.DEEPSEEK_MAX_TOKENS = "999999";
    process.chdir(tmp);

    const cfg = loadConfig({ web: { search_engine: "bing" }, baseUrl: "http://cli.local/v1" });
    const explain = explainConfig({ model: "deepseek-v4-flash" });

    expect(cfg.base_url).toBe("http://cli.local/v1");
    expect(cfg.web.search_engine).toBe("bing");
    expect(cfg.web.allowed_domains).toEqual(["env.example"]);
    expect(cfg.web.blocked_domains).toEqual(["project-block.example"]);
    expect(cfg.web.google_api_key).toBe("env-google");
    expect(cfg.web.google_cx).toBe("env-cx");
    expect(cfg.web.brave_api_key).toBe("env-brave");
    expect(cfg.web.searxng_url).toBe("https://env-search.example");
    expect(cfg.web.proxy).toBe("http://user.proxy:8080");
    expect(cfg.web.fetch_timeout_ms).toBe(2200);
    expect(cfg.max_tokens).toBe(262_144);
    expect(explain.conflicts.some(conflict => conflict.key === "model" && conflict.winner === "cli")).toBe(true);
  });

  it("migrates sandbox and web config keys and validates invalid policies", () => {
    const projectDir = join(tmp, ".deepseek");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "config.toml"), [
      'approvalPolicy = "never"',
      'sandboxMode = "danger-full-access"',
      "workspaceBoundary = false",
      'trustedWorkspaces = ["/tmp/trusted"]',
      "[web]",
      'searchEngine = "duckduckgo"',
      "noProxy = [\"localhost\"]",
      "",
    ].join("\n"));
    process.chdir(tmp);

    const dryRun = migrateProjectConfig({ dryRun: true });
    const report = migrateProjectConfig();
    const cfg = loadConfig();

    expect(dryRun.changed).toBe(true);
    expect(report.actions.join("\n")).toContain("approvalPolicy");
    expect(report.actions.join("\n")).toContain("web.searchEngine");
    expect(cfg.approval_policy).toBe("never");
    expect(cfg.sandbox_mode).toBe("danger-full-access");
    expect(cfg.workspace_boundary).toBe(false);
    expect(cfg.trusted_workspaces).toEqual(["/tmp/trusted"]);
    expect(cfg.web.no_proxy).toEqual(["localhost"]);

    writeFileSync(join(projectDir, "config.toml"), 'approval_policy = "maybe"\n');
    expect(validateConfig().ok).toBe(false);
    expect(validateConfig().issues.some(issue => issue.key === "approval_policy")).toBe(true);
  });
});

describe("sandbox and approval policy", () => {
  it("enforces workspace boundaries across root, cwd, workdir, files, and shell paths", () => {
    const config = testConfig({ workspace_boundary: true, trusted_workspaces: [tmp] });
    const writeTool = tool("write", PermissionLevel.ASK, "file");
    const bashTool = tool("bash", PermissionLevel.ASK, "shell");
    const gitTool = tool("git_diff", PermissionLevel.ALWAYS_ALLOW, "git");

    expect(checkSandboxPolicy(config, ctx(writeTool, "write", { path: "ok.txt", root: tmp }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(config, ctx(writeTool, "write", { path: "ok.txt", root: "/tmp" }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(config, ctx(gitTool, "git_diff", { files: ["src/a.ts", "/etc/passwd"], workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(config, ctx(bashTool, "bash", { command: "cat /etc/passwd", workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(config, ctx(bashTool, "bash", { command: `cat ${join(tmp, "README.md")}`, workdir: tmp }, tmp))).toMatchObject({ decision: "allow" });
  });

  it("applies approval policy, sandbox mode, and trust boundary consistently", () => {
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const writeTool = tool("write", PermissionLevel.ASK, "file");
    const bashTool = tool("bash", PermissionLevel.ASK, "shell");

    expect(isTrustedWorkspace(testConfig({ trusted_workspaces: ["~/trusted"] }), join(process.env.HOME!, "trusted", "repo"))).toBe(true);
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(writeTool, "write", { path: "x" }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(bashTool, "bash", { command: "cat file", workdir: tmp }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(testConfig({ sandbox_mode: "read-only" }), ctx(bashTool, "bash", { command: "cat file; rm file", workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "untrusted", trusted_workspaces: [] }), ctx(writeTool, "write", { path: "x" }, tmp))).toMatchObject({ decision: "ask" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "untrusted", trusted_workspaces: [tmp] }), ctx(writeTool, "write", { path: "x" }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "never", sandbox_mode: "danger-full-access" }), ctx(bashTool, "bash", { command: "rm -rf /" }, tmp))).toMatchObject({ decision: "allow" });
    expect(checkSandboxPolicy(testConfig({ approval_policy: "never", sandbox_mode: "workspace-write" }), ctx(bashTool, "bash", { command: "rm -rf /", workdir: tmp }, tmp))).toMatchObject({ decision: "deny" });
  });

  it("scopes one-shot approval cache entries by arguments and keeps always approvals broad", () => {
    const cache = getApprovalCache();

    cache.rememberApproval("write", "once", { path: "a.txt" });
    expect(checkApprovalCache("write", "ask", { path: "a.txt" })).toMatchObject({ decision: "approved" });
    expect(checkApprovalCache("write", "ask", { path: "a.txt" })).toMatchObject({ decision: "ask" });
    expect(checkApprovalCache("write", "ask", { path: "b.txt" })).toMatchObject({ decision: "ask" });

    cache.rememberDenial("write", DenialReason.USER_DENIED, { path: "danger.txt" });
    expect(checkApprovalCache("write", "ask", { path: "danger.txt" })).toMatchObject({ decision: "denied" });
    expect(checkApprovalCache("write", "ask", { path: "safe.txt" })).toMatchObject({ decision: "ask" });

    cache.rememberApproval("bash", "always", { command: "npm test" });
    expect(checkApprovalCache("bash", "ask", { command: "npm run build" })).toMatchObject({ decision: "approved" });
    cache.clearTool("bash");
    expect(checkApprovalCache("bash", "ask", { command: "npm run build" })).toMatchObject({ decision: "ask" });
  });
});

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    api_key: "",
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
    skills_dir: join(tmp, "skills"),
    skills_registry_url: "https://example.com/skills.json",
    skills_max_install_size_bytes: 5 * 1024 * 1024,
    theme: "deepseek-dark",
    context_refresh_enabled: true,
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    workspace_boundary: true,
    trusted_workspaces: [],
    lsp_auto_diagnostics: true,
    lsp_diagnostics_severity: "warning",
    tool_call_budget_per_turn: 80,
    tool_failure_degrade_threshold: 3,
    status_items: ["mode", "model", "workspace", "context", "cache", "tools", "elapsed", "cost", "hints"],
    web: {
      enabled: true,
      mode: "live",
      search_engine: "auto",
      allowed_domains: [],
      blocked_domains: [],
      proxy: "",
      no_proxy: [],
      search_timeout_ms: 15_000,
      fetch_timeout_ms: 15_000,
      max_bytes: 1_000_000,
    },
    ...overrides,
  };
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const key of keys) {
    values[key] = process.env[key];
    delete process.env[key];
  }
  return values;
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
