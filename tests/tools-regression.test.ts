import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { DeepSeekClient } from "../src/client/deepseek.js";
import type { StreamEvent } from "../src/client/base.js";
import type { Config } from "../src/config.js";
import { explainConfig, loadConfig, migrateProjectConfig, migrateUserConfig, validateConfig } from "../src/config.js";
import { calculateCost } from "../src/cost/pricing.js";
import { ContextCompactor } from "../src/engine/compact.js";
import type { EngineRuntimeEvent } from "../src/engine/events.js";
import { Engine } from "../src/engine/loop.js";
import { clearHooks, registerHook } from "../src/engine/hooks.js";
import { getMode } from "../src/modes/base.js";
import { ConversationHistory } from "../src/session/history.js";
import { createSession } from "../src/session/types.js";
import { getRegistry } from "../src/tools/registry.js";
import { PermissionLevel } from "../src/tools/base.js";
import { registerFileTools } from "../src/tools/file-ops.js";
import { registerGitTools } from "../src/tools/git.js";
import { registerPatchTool } from "../src/tools/patch.js";
import { applyPatch as applyAdvancedPatch } from "../src/tools/patch-advanced.js";
import { SideGit } from "../src/rollback/side-git.js";
import { registerToolSearchTool } from "../src/tools/tool-search.js";
import { registerDiagnosticsTools } from "../src/tools/diagnostics.js";
import { registerArtifactTools } from "../src/tools/artifacts.js";
import { clearArtifactsForTests, listArtifactLinks, readArtifact } from "../src/artifacts/store.js";
import { clearMCPManagerForTests, getMCPManager } from "../src/mcp/manager.js";
import { activateSkill, applySkillToUserInput, installSkillFromArchive, scanSkills, trustSkill, uninstallSkill } from "../src/engine/skills.js";

let tmp: string;
let oldArtifactsDir: string | undefined;
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-tools-"));
  oldArtifactsDir = process.env.DEEPCODE_ARTIFACTS_DIR;
  oldHome = process.env.HOME;
  process.env.DEEPCODE_ARTIFACTS_DIR = join(tmp, "artifacts");
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  clearArtifactsForTests();
  getRegistry().clear();
  clearHooks();
});

afterEach(async () => {
  clearHooks();
  await clearMCPManagerForTests();
  clearArtifactsForTests();
  if (oldArtifactsDir === undefined) delete process.env.DEEPCODE_ARTIFACTS_DIR;
  else process.env.DEEPCODE_ARTIFACTS_DIR = oldArtifactsDir;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("file tools", () => {
  it("glob matches nested paths with normal wildcard semantics", async () => {
    registerFileTools();
    writeFileSync(join(tmp, "a.ts"), "root");
    const nested = join(tmp, "src", "nested");
    await getRegistry().lookup("write")!.execute({ path: join(nested, "b.ts"), content: "nested", root: tmp });
    writeFileSync(join(nested, "c.js"), "nope");

    const result = await getRegistry().lookup("glob")!.execute({ path: tmp, pattern: "src/**/*.ts" });

    expect(result).toContain("src/nested/b.ts");
    expect(result).not.toContain("a.ts");
    expect(result).not.toContain("c.js");
  });

  it("search treats patterns literally and does not execute shell substitutions", async () => {
    registerFileTools();
    rmSync("SHOULD_NOT_EXIST", { force: true });
    writeFileSync(join(tmp, "notes.txt"), "literal $(touch SHOULD_NOT_EXIST) marker\n");

    const result = await getRegistry().lookup("search")!.execute({ path: tmp, pattern: "$(touch SHOULD_NOT_EXIST)" });

    expect(result).toContain("notes.txt");
    expect(existsSync(join(tmp, "SHOULD_NOT_EXIST"))).toBe(false);
    expect(existsSync("SHOULD_NOT_EXIST")).toBe(false);
  });

  it("edit rejects an empty old_string instead of corrupting the file", async () => {
    registerFileTools();
    const file = join(tmp, "file.txt");
    writeFileSync(file, "abc");

    const result = await getRegistry().lookup("edit")!.execute({ path: file, old_string: "", new_string: "x", root: tmp });

    expect(result).toMatch(/old_string.*empty/i);
    expect(readFileSync(file, "utf-8")).toBe("abc");
  });

  it("handles paths with spaces and Chinese characters", async () => {
    registerFileTools();
    const dir = join(tmp, "目录 with spaces");
    const file = join(dir, "文件 名.txt");

    const write = await getRegistry().lookup("write")!.execute({ path: file, content: "你好\nsecond line", root: tmp });
    const read = await getRegistry().lookup("read")!.execute({ path: file, root: tmp });
    const list = await getRegistry().lookup("ls")!.execute({ path: dir });
    const search = await getRegistry().lookup("search")!.execute({ path: dir, pattern: "你好" });
    const glob = await getRegistry().lookup("glob")!.execute({ path: tmp, pattern: "目录 with spaces/*.txt" });

    expect(write).toContain("Successfully wrote");
    expect(write).toContain("[diff]");
    expect(write).toContain("+ 你好");
    expect(read).toContain("你好");
    expect(list).toContain("文件 名.txt");
    expect(search).toContain("文件 名.txt");
    expect(glob).toContain("目录 with spaces/文件 名.txt");
  });

  it("resolves relative file paths from the explicit root", async () => {
    registerFileTools();
    const root = join(tmp, "workspace root");
    mkdirSync(root, { recursive: true });

    const write = await getRegistry().lookup("write")!.execute({ path: "目录/文件.txt", content: "root-relative", root });
    const read = await getRegistry().lookup("read")!.execute({ path: "目录/文件.txt", root });
    const list = await getRegistry().lookup("ls")!.execute({ path: "目录", root });
    const search = await getRegistry().lookup("search")!.execute({ path: ".", pattern: "root-relative", root });
    const glob = await getRegistry().lookup("glob")!.execute({ path: ".", pattern: "目录/*.txt", root });

    expect(write).toContain("Successfully wrote");
    expect(write).toContain("[diff]");
    expect(read).toBe("root-relative");
    expect(list).toContain("文件.txt");
    expect(search).toContain("文件.txt");
    expect(glob).toContain("目录/文件.txt");
  });

  it("does not follow symlinks that escape the requested root", async () => {
    registerFileTools();
    const root = join(tmp, "root");
    const outside = join(tmp, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "SECRET_TOKEN\n");
    symlinkSync(outside, join(root, "linked-outside"), "dir");

    const read = await getRegistry().lookup("read")!.execute({ path: join(root, "linked-outside", "secret.txt"), root });
    const glob = await getRegistry().lookup("glob")!.execute({ path: root, pattern: "**/*.txt" });
    const search = await getRegistry().lookup("search")!.execute({ path: root, pattern: "SECRET_TOKEN" });

    expect(read).toMatch(/outside root|symlink|escape/i);
    expect(glob).not.toContain("secret.txt");
    expect(search).toContain("No matches found");
    expect(search).not.toContain("secret.txt");
  });

  it("rejects direct symlink roots that escape the workspace boundary", async () => {
    registerFileTools();
    const root = join(tmp, "root");
    const outside = join(tmp, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "SECRET_TOKEN\n");
    symlinkSync(outside, join(root, "linked-outside"), "dir");
    const linked = join(root, "linked-outside");

    const list = await getRegistry().lookup("ls")!.execute({ path: linked, root });
    const search = await getRegistry().lookup("search")!.execute({ path: linked, pattern: "SECRET_TOKEN", root });
    const glob = await getRegistry().lookup("glob")!.execute({ path: linked, pattern: "**/*.txt", root });

    expect(list).toMatch(/symlink|escape/i);
    expect(search).toMatch(/symlink|escape/i);
    expect(glob).toMatch(/symlink|escape/i);
  });
});

describe("git and patch tools", () => {
  it("git_diff handles file names with spaces", async () => {
    registerGitTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file with space.txt"), "old\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "file with space.txt"), "new\n");

    const result = await getRegistry().lookup("git_diff")!.execute({ workdir: tmp, files: "file with space.txt" });

    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });

  it("apply_patch cleans up temp files after a failed patch", async () => {
    registerPatchTool();
    const before = tempPatchFiles();

    const result = await getRegistry().lookup("apply_patch")!.execute({ patch: "not a patch" });

    expect(result).toMatch(/Patch failed/i);
    expect(tempPatchFiles()).toEqual(before);
  });

  it("advanced patch add excludes diff headers from file contents", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0]).toMatchObject({ type: "add", path: "new.txt" });
    expect(readFileSync(join(tmp, "new.txt"), "utf-8")).toBe("hello\nworld");
  });

  it("registered apply_patch includes a compact diff preview", async () => {
    registerPatchTool();
    writeFileSync(join(tmp, "preview.txt"), "old\n");
    const patch = [
      "diff --git a/preview.txt b/preview.txt",
      "index 1111111..2222222 100644",
      "--- a/preview.txt",
      "+++ b/preview.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const result = await getRegistry().lookup("apply_patch")!.execute({ patch, workdir: tmp });

    expect(result).toContain("Patch applied successfully");
    expect(result).toContain("[diff]");
    expect(result).toContain("- old");
    expect(result).toContain("+ new");
  });

  it("advanced patch rejects paths that escape the workdir", () => {
    const outside = join(tmp, "..", "outside.txt");
    const patch = [
      "diff --git a/../outside.txt b/../outside.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/../outside.txt",
      "@@ -0,0 +1 @@",
      "+owned",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0].type).toBe("error");
    expect(result[0].message).toMatch(/escapes workdir/i);
    expect(existsSync(outside)).toBe(false);
  });

  it("advanced patch deletes files in ESM without require", () => {
    const file = join(tmp, "delete-me.txt");
    writeFileSync(file, "remove\n");
    const patch = [
      "diff --git a/delete-me.txt b/delete-me.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/delete-me.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-remove",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0]).toMatchObject({ type: "delete", path: "delete-me.txt" });
    expect(existsSync(file)).toBe(false);
  });

  it("advanced patch applies multi-file changes atomically on failure", () => {
    writeFileSync(join(tmp, "a.txt"), "before-a\n");
    writeFileSync(join(tmp, "b.txt"), "before-b\n");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-before-a",
      "+after-a",
      "diff --git a/b.txt b/b.txt",
      "index 1111111..2222222 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-missing-b",
      "+after-b",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result.some(item => item.type === "error")).toBe(true);
    expect(readFileSync(join(tmp, "a.txt"), "utf-8")).toBe("before-a\n");
    expect(readFileSync(join(tmp, "b.txt"), "utf-8")).toBe("before-b\n");
  });

  it("registered apply_patch uses workdir and keeps multi-file failures atomic", async () => {
    registerPatchTool();
    writeFileSync(join(tmp, "a.txt"), "before-a\n");
    writeFileSync(join(tmp, "b.txt"), "before-b\n");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-before-a",
      "+after-a",
      "diff --git a/b.txt b/b.txt",
      "index 1111111..2222222 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-missing-b",
      "+after-b",
      "",
    ].join("\n");

    const result = await getRegistry().lookup("apply_patch")!.execute({ patch, workdir: tmp });

    expect(result).toMatch(/Patch failed/i);
    expect(readFileSync(join(tmp, "a.txt"), "utf-8")).toBe("before-a\n");
    expect(readFileSync(join(tmp, "b.txt"), "utf-8")).toBe("before-b\n");
  });

  it("advanced patch dry-run does not create parent directories", () => {
    const patch = [
      "diff --git a/嵌套 dir/new.txt b/嵌套 dir/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/嵌套 dir/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp, dryRun: true });

    expect(result[0]).toMatchObject({ type: "add", path: "嵌套 dir/new.txt" });
    expect(existsSync(join(tmp, "嵌套 dir"))).toBe(false);
  });

  it("advanced patch rejects missing deletes before changing other files", () => {
    writeFileSync(join(tmp, "a.txt"), "before-a\n");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-before-a",
      "+after-a",
      "diff --git a/missing.txt b/missing.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/missing.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result.some(item => item.type === "error")).toBe(true);
    expect(readFileSync(join(tmp, "a.txt"), "utf-8")).toBe("before-a\n");
  });

  it("advanced patch applies renames from the source path", () => {
    writeFileSync(join(tmp, "old name.txt"), "before\n");
    const patch = [
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 50%",
      "rename from old name.txt",
      "rename to new name.txt",
      "--- a/old name.txt",
      "+++ b/new name.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir: tmp });

    expect(result[0]).toMatchObject({ type: "update", path: "new name.txt" });
    expect(existsSync(join(tmp, "old name.txt"))).toBe(false);
    expect(readFileSync(join(tmp, "new name.txt"), "utf-8")).toBe("after\n");
  });

  it("advanced patch rejects writes through symlinks that escape the workdir", () => {
    const outside = join(tmp, "outside");
    const root = join(tmp, "root");
    const workdir = join(root, "workdir");
    mkdirSync(outside, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(outside, "target.txt"), "outside\n");
    symlinkSync(join(outside, "target.txt"), join(workdir, "linked.txt"));
    const patch = [
      "diff --git a/linked.txt b/linked.txt",
      "index 1111111..2222222 100644",
      "--- a/linked.txt",
      "+++ b/linked.txt",
      "@@ -1 +1 @@",
      "-outside",
      "+owned",
      "",
    ].join("\n");

    const result = applyAdvancedPatch(patch, { workdir });

    expect(result[0].type).toBe("error");
    expect(result[0].message).toMatch(/symlink|escapes workdir/i);
    expect(readFileSync(join(outside, "target.txt"), "utf-8")).toBe("outside\n");
  });
});

describe("tool catalog", () => {
  it("returns stable sorted schemas and activates deferred tools through tool_search", async () => {
    getRegistry().register({
      name: "z_deferred",
      description: "rare github helper",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      deferLoading: true,
      execute: async () => "ok",
    });
    getRegistry().register({
      name: "a_active",
      description: "common helper",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "ok",
    });
    registerToolSearchTool();

    expect(getRegistry().listAll().map(tool => tool.name)).toEqual(["a_active", "tool_enable", "tool_search", "tool_stats", "z_deferred"]);
    expect(getRegistry().listActive().map(tool => tool.name)).toEqual(["a_active", "tool_enable", "tool_search", "tool_stats"]);
    await getRegistry().lookup("tool_search")!.execute({ query: "github" });
    expect(getRegistry().listActive().map(tool => tool.name)).toEqual(["a_active", "tool_enable", "tool_search", "tool_stats", "z_deferred"]);
  });

  it("tracks tool failures and degrades unhealthy tools", async () => {
    registerToolSearchTool();
    getRegistry().register({
      name: "flaky",
      description: "flaky tool",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "Error: fail",
    });
    const stats = getRegistry().recordCall("flaky", false, 5);
    const reason = getRegistry().degradeIfUnhealthy("flaky", 1);

    expect(stats.failures).toBe(1);
    expect(reason).toContain("disabled");
    expect(getRegistry().listActive().map(tool => tool.name)).not.toContain("flaky");
    expect(await getRegistry().lookup("tool_enable")!.execute({ name: "flaky" })).toContain("Enabled");
  });

  it("normalizes capability metadata, aliases, and search hints", async () => {
    getRegistry().register({
      name: "read",
      aliases: ["old_read"],
      description: "custom read helper",
      searchHint: "notebook context lookup",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      maxResultSizeChars: 1234,
      execute: async () => "ok",
    });

    expect(getRegistry().lookup("old_read")?.name).toBe("read");
    expect(getRegistry().search("notebook readonly")[0]?.tool.name).toBe("read");
    expect(getRegistry().toolStats().find(item => item.name === "read")).toMatchObject({
      read_only: true,
      concurrency_safe: true,
      search_hint: "notebook context lookup",
      max_result_size_chars: 1234,
    });

    getRegistry().register({
      name: "read",
      aliases: ["new_read"],
      description: "replacement read helper",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "new",
    });

    expect(getRegistry().lookup("old_read")).toBeUndefined();
    expect(getRegistry().lookup("new_read")?.name).toBe("read");
  });

  it("tool_search activates by searchHint and renders capability tags", async () => {
    getRegistry().register({
      name: "rare_reader",
      description: "rare helper",
      searchHint: "notebook context lookup",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      readOnly: true,
      deferLoading: true,
      execute: async () => "ok",
    });
    registerToolSearchTool();

    const result = await getRegistry().lookup("tool_search")!.execute({ query: "notebook" });

    expect(result).toContain("rare_reader");
    expect(result).toContain("read-only");
    expect(result).toContain("concurrent");
    expect(result).toContain("hint: notebook context lookup");
    expect(getRegistry().listActive().map(tool => tool.name)).toContain("rare_reader");
  });

  it("registers diagnostics and deferred ecosystem tools", () => {
    registerDiagnosticsTools();

    expect(getRegistry().lookup("diagnostics")).toBeTruthy();
    expect(getRegistry().lookup("github_issue_context")?.deferLoading).toBe(true);
    expect(getRegistry().lookup("automation_create")?.deferLoading).toBe(true);
  });
});

describe("side git rollback", () => {
  it("snapshots and restores workspaces whose paths contain spaces", async () => {
    const workspace = join(tmp, "workspace with spaces");
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(workspace, { recursive: true }));
    const file = join(workspace, "file.txt");
    writeFileSync(file, "before\n");
    const sideGit = new SideGit(workspace);

    expect(await sideGit.init()).toBe(true);
    const snap = await sideGit.snapshotPre(1);
    expect(snap).toBeTruthy();
    writeFileSync(file, "after\n");
    const snapshots = await sideGit.listSnapshots();

    expect(snapshots[0].message).toBe("pre-turn-1");
    expect(await sideGit.restoreTo(snapshots[0].hash)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("before\n");
  });

  it("restores dirty tracked and untracked changes in Unicode paths", async () => {
    const workspace = join(tmp, "工作区 with spaces");
    mkdirSync(workspace, { recursive: true });
    const tracked = join(workspace, "文件.txt");
    const addedAfterSnapshot = join(workspace, "新增.txt");
    writeFileSync(tracked, "before\n");
    const sideGit = new SideGit(workspace);

    expect(await sideGit.init()).toBe(true);
    const snap = await sideGit.snapshotPre("中文 turn");
    expect(snap).toBeTruthy();
    writeFileSync(tracked, "after\n");
    writeFileSync(addedAfterSnapshot, "new\n");
    const snapshots = await sideGit.listSnapshots();

    expect(await sideGit.restoreTo(snapshots[0].hash)).toBe(true);
    expect(readFileSync(tracked, "utf-8")).toBe("before\n");
    expect(existsSync(addedAfterSnapshot)).toBe(false);
  });

  it("preserves side-git history and removes files added by later snapshots", async () => {
    const workspace = join(tmp, "restore history");
    mkdirSync(workspace, { recursive: true });
    const original = join(workspace, "原始.txt");
    const later = join(workspace, "later file.txt");
    writeFileSync(original, "before\n");
    const sideGit = new SideGit(workspace);

    expect(await sideGit.init()).toBe(true);
    const pre = await sideGit.snapshotPre(1);
    expect(pre).toBeTruthy();
    writeFileSync(original, "after\n");
    writeFileSync(later, "new\n");
    expect(await sideGit.snapshotPost(1)).toBeTruthy();
    const snapshots = await sideGit.listSnapshots();

    expect(await sideGit.restoreTo(snapshots.find(item => item.message === "pre-turn-1")!.hash)).toBe(true);
    expect(readFileSync(original, "utf-8")).toBe("before\n");
    expect(existsSync(later)).toBe(false);
    expect(existsSync(join(workspace, ".seekcode", "side-git", "HEAD"))).toBe(true);
    expect((await sideGit.listSnapshots()).map(item => item.message)).toEqual(["post-turn-1", "pre-turn-1"]);
  });
});

describe("engine", () => {
  it("records errored tool executions in the turn result", async () => {
    getRegistry().register({
      name: "fail_tool",
      description: "fails",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => { throw new Error("boom"); },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "fail_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("boom");
  });

  it("records unknown tool calls in the turn result", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "missing_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const previews: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("Unknown tool");
    expect(previews[0]).toContain("Unknown tool");
  });

  it("passes full successful tool output to UI previews so diff blocks survive", async () => {
    getRegistry().register({
      name: "diff_tool",
      description: "returns a diff",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "file",
      execute: async () => [
        "Successfully edited x.ts",
        "",
        "[diff]",
        "  ── x.ts ──",
        "- old",
        "+ new",
      ].join("\n"),
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "diff_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const previews: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
    });

    expect(previews[0]).toContain("[diff]");
    expect(previews[0]).toContain("+ new");
  });

  it("emits stable runtime events while keeping legacy UI callbacks compatible", async () => {
    getRegistry().register({
      name: "event_tool",
      description: "returns ok",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => "event tool ok",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      [
        { type: "thinking", text: "think" } as any,
        { type: "content", text: "call tool" } as any,
        { type: "tool_call_begin", index: 0, tool_call_id: "call_1", name: "event_tool" } as any,
        { type: "done", finish_reason: "tool_calls", usage: null, content: "call tool", reasoning_content: "think", tool_calls: [{ id: "call_1", name: "event_tool", arguments: {} }] },
      ],
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const legacy: string[] = [];
    const engine = new Engine({ ...testConfig(), reasoning_effort: "high" }, session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
      onThinking: async (text) => { legacy.push(`thinking:${text}`); },
      onContent: async (text) => { legacy.push(`content:${text}`); },
      onToolCallStart: async (name) => { legacy.push(`tool_call:${name}`); },
      onToolExecuted: async (name, preview) => { legacy.push(`tool_result:${name}:${preview}`); },
    });

    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      "user_message",
      "api_call_start",
      "thinking_delta",
      "content_delta",
      "tool_call_begin",
      "assistant_message",
      "tool_call",
      "tool_result",
    ]));
    expect(events.find(event => event.type === "tool_result")).toMatchObject({
      type: "tool_result",
      data: { name: "event_tool", content: "event tool ok", is_error: false },
      preview: "event tool ok",
    });
    expect(legacy).toEqual(expect.arrayContaining([
      "thinking:think",
      "content:call tool",
      "tool_call:event_tool",
      "tool_result:event_tool:event tool ok",
    ]));
  });

  it("stores oversized tool results as artifacts and sends only a preview to the model", async () => {
    const largeOutput = [
      "head-marker",
      "A".repeat(60_000),
      "tail-marker",
    ].join("\n");
    getRegistry().register({
      name: "large_tool",
      description: "returns a large result",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      execute: async () => largeOutput,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "large_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const previews: string[] = [];
    const runtimeArtifactIds: string[][] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
      onRuntimeItem: async (item) => {
        if (item.type === "tool_result") runtimeArtifactIds.push(item.artifact_ids || []);
      },
    });

    expect(result.artifact_ids).toHaveLength(1);
    const artifactId = result.artifact_ids[0];
    expect(previews[0]).toContain("[Tool result stored as artifact]");
    expect(previews[0]).toContain(`artifact_id: ${artifactId}`);
    expect(previews[0]).not.toContain("A".repeat(20_000));
    expect(result.tool_results[0].content).toContain("[Tool result stored as artifact]");
    expect(result.tool_results[0].content).toContain(`artifact_id: ${artifactId}`);
    expect(result.tool_results[0].content).toContain("artifact_read");
    expect(result.tool_results[0].content.length).toBeLessThan(10_000);
    expect(result.tool_results[0].content).not.toContain("A".repeat(20_000));
    expect(runtimeArtifactIds[0]).toContain(artifactId);

    const toolMessage = session.messages.find(message => message.role === "tool" && message.tool_call_id === "call_1");
    expect(toolMessage?.content).toBe(result.tool_results[0].content);
    expect(client.calls[1].messages.find((message: any) => message.role === "tool")?.content).toBe(result.tool_results[0].content);
    expect(readArtifact(artifactId)).toContain(largeOutput);
  });

  it("uses per-tool result budgets instead of only the global default", async () => {
    const output = `small-head\n${"B".repeat(800)}\nsmall-tail`;
    getRegistry().register({
      name: "budget_tool",
      description: "returns a result over its own budget",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      maxResultSizeChars: 100,
      execute: async () => output,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "budget_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.artifact_ids).toHaveLength(1);
    expect(result.tool_results[0].content).toContain("[Tool result stored as artifact]");
    expect(result.tool_results[0].content).not.toContain("B".repeat(500));
    expect(readArtifact(result.artifact_ids[0])).toContain(output);
  });

  it("validates tool input before execution and returns a structured tool error", async () => {
    let executed = false;
    getRegistry().register({
      name: "validated_tool",
      description: "validates input",
      parameters: { type: "object", properties: { required_value: { type: "string" } } },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      validateInput: (args) => typeof args.required_value === "string" && args.required_value
        ? { ok: true }
        : { ok: false, message: "required_value is required" },
      execute: async () => { executed = true; return "should not run"; },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "validated_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "handled", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(executed).toBe(false);
    expect(result.tool_results[0]).toMatchObject({ is_error: true });
    expect(result.tool_results[0].content).toContain("required_value is required");
    expect(client.calls[1].messages.find((message: any) => message.role === "tool")?.content).toContain("invalid input");
  });

  it("emits tool progress events and rendered result metadata", async () => {
    getRegistry().register({
      name: "progress_tool",
      description: "reports progress",
      parameters: { type: "object", properties: {} },
      permission: PermissionLevel.ALWAYS_ALLOW,
      category: "test",
      parallelOk: true,
      renderProgress: (progress) => ({ kind: "task", preview: `rendered ${progress.message}` }),
      renderResult: (result) => ({ kind: "json", preview: `rendered result ${result}` }),
      execute: async (_args, context) => {
        await context?.onProgress?.({ message: "halfway", percent: 50 });
        return "ok";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "progress_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const events: EngineRuntimeEvent[] = [];
    const previews: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onRuntimeEvent: async (event) => { events.push(event); },
      onToolExecuted: async (_name, preview) => { previews.push(preview); },
    });

    const progress = events.find(event => event.type === "tool_progress");
    const resultEvent = events.find(event => event.type === "tool_result");
    expect(progress).toMatchObject({
      data: { tool: "progress_tool", progress: { message: "halfway", percent: 50 } },
      rendered: { preview: "rendered halfway" },
    });
    expect(resultEvent).toMatchObject({ rendered: { kind: "json", preview: "rendered result ok" } });
    expect(previews[0]).toBe("rendered result ok");
  });

  it("records denied tool calls in the turn result", async () => {
    getRegistry().register({
      name: "ask_tool",
      description: "needs approval",
      parameters: { type: "object", properties: {} },
      permission: "ask" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "ask_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_results).toHaveLength(1);
    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("denied");
  });

  it("sends errored tool results back to the next model call", async () => {
    getRegistry().register({
      name: "fail_tool",
      description: "fails",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "Error: failed intentionally",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: { prompt_tokens: 5, completion_tokens: 1 }, content: "", reasoning_content: "need fail", tool_calls: [{ id: "call_1", name: "fail_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: { prompt_tokens: 7, completion_tokens: 2, prompt_cache_hit_tokens: 3, prompt_tokens_details: { cached_tokens: 3 } } as any, content: "handled", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine({ ...testConfig(), reasoning_effort: "high" }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(client.calls[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [{ id: "call_1", name: "fail_tool", arguments: {} }],
        reasoning_content: "need fail",
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_1",
        name: "fail_tool",
        content: "Error: failed intentionally",
        is_error: true,
      }),
    ]));
    expect(result.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 3,
      prompt_cache_hit_tokens: 3,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  it("passes AbortSignal from engine turns into the client", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());
    const controller = new AbortController();

    await engine.runTurn("go", getMode("agent"), undefined, { signal: controller.signal });

    expect(client.lastSignal).toBe(controller.signal);
  });

  it("passes AbortSignal from engine turns into tools", async () => {
    let seenSignal: AbortSignal | undefined;
    getRegistry().register({
      name: "signal_tool",
      description: "records signal",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async (_args, context) => {
        seenSignal = context?.signal;
        return "ok";
      },
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const controller = new AbortController();
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "signal_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), undefined, { signal: controller.signal });

    expect(seenSignal).toBe(controller.signal);
  });

  it("stops streaming promptly after AbortSignal is triggered", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const controller = new AbortController();
    const client = new FakeClient([[
      { type: "content", text: "first" } as any,
      { type: "content", text: "second" } as any,
      { type: "done", finish_reason: "stop", usage: null, content: "firstsecond", reasoning_content: null, tool_calls: [] },
    ]]);
    const content: string[] = [];
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    await expect(engine.runTurn("go", getMode("agent"), {
      onContent: async (text) => {
        content.push(text);
        controller.abort();
      },
    }, { signal: controller.signal })).rejects.toThrow(/aborted/i);

    expect(content).toEqual(["first"]);
    expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(0);
  });

  it("records tool budget exhaustion as an error result and stops the turn", async () => {
    getRegistry().register({
      name: "ok_tool",
      description: "ok",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => "ok",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [
        { id: "call_1", name: "ok_tool", arguments: {} },
        { id: "call_2", name: "ok_tool", arguments: {} },
      ] },
      { type: "done", finish_reason: "stop", usage: null, content: "should not be called", reasoning_content: null, tool_calls: [] },
    ]);
    const runtimeItems: string[] = [];
    const engine = new Engine({ ...testConfig(), tool_call_budget_per_turn: 1 }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      onRuntimeItem: async (item) => { runtimeItems.push(item.type); },
    });

    expect(result.tool_calls.map(call => call.id)).toEqual(["call_1", "call_2"]);
    expect(result.tool_results).toHaveLength(2);
    expect(result.tool_results[1]).toMatchObject({ tool_call_id: "call_2", is_error: true });
    expect(result.tool_results[1].content).toContain("tool call budget exceeded");
    expect(runtimeItems).toContain("tool_budget_exceeded");
    expect(client.calls).toHaveLength(1);
  });

  it("fills pending tool results when a turn is interrupted during tool execution", async () => {
    let engine: Engine;
    getRegistry().register({
      name: "interrupting_tool",
      description: "interrupts the turn",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: false,
      execute: async () => {
        engine.interrupt();
        return "Error: interrupted";
      },
    });
    getRegistry().register({
      name: "pending_tool",
      description: "should not run",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: false,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [
        { id: "call_1", name: "interrupting_tool", arguments: {} },
        { id: "call_2", name: "pending_tool", arguments: {} },
      ] },
      { type: "done", finish_reason: "stop", usage: null, content: "should not be called", reasoning_content: null, tool_calls: [] },
    ]);
    engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    const assistant = session.messages.find(message => message.role === "assistant" && message.tool_calls?.length);
    const toolResults = session.messages.filter(message => message.role === "tool");
    expect(assistant?.tool_calls?.map(call => call.id)).toEqual(["call_1", "call_2"]);
    expect(toolResults.map(message => message.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(result.tool_results.map(item => item.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(result.tool_results[1].content).toContain("interrupted before tool");
    expect(client.calls).toHaveLength(1);
  });

  it("injects context intervention markers under token pressure", async () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    history.addUser("x".repeat(600));
    const client = new FakeClient([
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const interventions: unknown[] = [];
    const engine = new Engine({ ...testConfig(), context_limit: 100 }, session, history, client as any, getRegistry());

    await engine.runTurn("go", getMode("agent"), {
      onContextIntervention: async (intervention) => { interventions.push(intervention); },
    });

    expect(interventions.length).toBeGreaterThan(0);
    expect(session.messages.some(message => message.name === "context_verification")).toBe(true);
  });

  it("adds explicit compaction boundary messages when compacting context", () => {
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    for (let i = 0; i < 16; i++) {
      history.addUser(`old user ${i} ${"x".repeat(400)}`);
      history.addAssistant(`old assistant ${i}`, null, "reasoning".repeat(80));
    }
    const compactor = new ContextCompactor({ ...testConfig(), context_limit: 100 });

    const result = compactor.compact(history);

    const boundary = session.messages.find(message => message.name === "context_compaction_boundary");
    expect(result.boundary_id).toBeTruthy();
    expect(result.removed_messages).toBeGreaterThan(0);
    expect(boundary?.role).toBe("system");
    expect(boundary?.content).toContain("[Context compaction boundary]");
    expect(boundary?.content).toContain(`boundary_id: ${result.boundary_id}`);
    expect(boundary?.content).toContain("removed_messages:");
    expect(boundary?.content).toContain("recovery:");
    expect(result.actions.some(action => action.startsWith("summarizeOld:"))).toBe(true);
  });

  it("blocks tool paths that escape the workspace boundary", async () => {
    getRegistry().register({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "file",
      parallelOk: false,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "../escape.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(result.tool_results[0].is_error).toBe(true);
    expect(result.tool_results[0].content).toContain("sandbox");
  });

  it("requires sandbox approval for mutations in untrusted workspaces", async () => {
    getRegistry().register({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "file",
      parallelOk: false,
      execute: async () => "should not run",
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "write", arguments: { path: "inside.txt", content: "x" } }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    let approvalRequests = 0;
    const engine = new Engine({ ...testConfig(), approval_policy: "untrusted" }, session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"), {
      requestApproval: async () => { approvalRequests++; return false; },
    });

    expect(approvalRequests).toBe(1);
    expect(result.tool_results[0].content).toContain("denied");
  });

  it("blocks tool execution when a PreToolUse hook denies it", async () => {
    let executed = false;
    getRegistry().register({
      name: "hooked_tool",
      description: "hooked",
      parameters: { type: "object", properties: {} },
      permission: "always_allow" as any,
      category: "test",
      parallelOk: true,
      execute: async () => { executed = true; return "should not run"; },
    });
    registerHook({
      event: "PreToolUse",
      matcher: "hooked_tool",
      command: `${process.execPath} -e "console.log(JSON.stringify({decision:'deny', message:'hook blocked'}))"`,
    });
    const session = createSession({ workspace_path: tmp });
    const history = new ConversationHistory(session);
    history.addSystem("system");
    const client = new FakeClient([
      { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "hooked_tool", arguments: {} }] },
      { type: "done", finish_reason: "stop", usage: null, content: "done", reasoning_content: null, tool_calls: [] },
    ]);
    const engine = new Engine(testConfig(), session, history, client as any, getRegistry());

    const result = await engine.runTurn("go", getMode("agent"));

    expect(executed).toBe(false);
    expect(result.tool_results[0]).toMatchObject({ is_error: true });
    expect(result.tool_results[0].content).toContain("hook blocked");
  });
});

describe("config and pricing", () => {
  it("creates ~/.seekcode/config.toml with defaults on first config load", () => {
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");

    expect(existsSync(userConfig)).toBe(false);
    const cfg = loadConfig();

    expect(cfg.api_key).toBe("");
    expect(existsSync(userConfig)).toBe(true);
    expect(readFileSync(userConfig, "utf-8")).toContain('api_key = ""');
  });

  it("does not auto-copy legacy user config on first config load", () => {
    const legacyUserDir = join(process.env.HOME!, ".config", "deepseek");
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");
    mkdirSync(legacyUserDir, { recursive: true });
    writeFileSync(join(legacyUserDir, "config.toml"), 'api_key = "legacy-key"\nbaseUrl = "http://legacy.local"\n');

    const cfg = loadConfig();

    expect(cfg.api_key).toBe("");
    expect(existsSync(userConfig)).toBe(true);
    const raw = readFileSync(userConfig, "utf-8");
    expect(raw).toContain('api_key = ""');
    expect(raw).not.toContain("legacy-key");
    expect(raw).not.toContain("baseUrl");
  });

  it("migrates legacy user config only when explicitly requested", () => {
    const legacyUserDir = join(process.env.HOME!, ".config", "deepseek");
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");
    mkdirSync(legacyUserDir, { recursive: true });
    writeFileSync(join(legacyUserDir, "config.toml"), 'api_key = "legacy-key"\nbaseUrl = "http://legacy.local"\n');

    expect(loadConfig().api_key).toBe("");
    const report = migrateUserConfig();

    expect(report.changed).toBe(true);
    expect(report.actions.join("\n")).toContain("copied legacy config");
    const raw = readFileSync(userConfig, "utf-8");
    expect(raw).toContain("legacy-key");
    expect(raw).toContain("base_url");
    expect(raw).not.toContain("baseUrl");
  });

  it("ignores invalid numeric environment values instead of throwing", () => {
    const old = process.env.DEEPSEEK_MAX_TOKENS;
    process.env.DEEPSEEK_MAX_TOKENS = "not-a-number";
    try {
      expect(() => loadConfig({})).not.toThrow();
      expect(loadConfig({}).max_tokens).toBe(8192);
    } finally {
      if (old === undefined) delete process.env.DEEPSEEK_MAX_TOKENS;
      else process.env.DEEPSEEK_MAX_TOKENS = old;
    }
  });

  it("applies provider defaults and V4 context limits", () => {
    const cfg = loadConfig({ provider: "nvidia-nim", model: "deepseek-v4-flash" });

    expect(cfg.base_url).toBe("https://integrate.api.nvidia.com/v1");
    expect(cfg.model).toBe("deepseek-ai/deepseek-v4-flash");
    expect(cfg.context_limit).toBe(1_000_000);
  });

  it("keeps explicit base_url when switching provider config", () => {
    const cfg = loadConfig({ provider: "openrouter", model: "deepseek-v4-pro", base_url: "http://proxy.local/v1" });

    expect(cfg.base_url).toBe("http://proxy.local/v1");
    expect(cfg.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("loads ~/.seekcode config without implicitly reading legacy DeepSeek paths", () => {
    const legacyUserDir = join(process.env.HOME!, ".config", "deepseek");
    const userDir = join(process.env.HOME!, ".seekcode");
    const legacyProjectDir = join(tmp, ".deepseek");
    const projectDir = join(tmp, ".seekcode");
    mkdirSync(legacyUserDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    mkdirSync(legacyProjectDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(legacyUserDir, "config.toml"), 'api_key = "legacy-user-key"\nmodel = "deepseek-v4-flash"\n');
    writeFileSync(join(userDir, "config.toml"), 'api_key = "seekcode-user-key"\n');
    writeFileSync(join(legacyProjectDir, "config.toml"), 'mode = "plan"\n');
    writeFileSync(join(projectDir, "config.toml"), 'mode = "agent"\n');
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const cfg = loadConfig();
      const explain = explainConfig();

      expect(cfg.api_key).toBe("seekcode-user-key");
      expect(cfg.model).toBe("deepseek-v4-pro");
      expect(cfg.mode).toBe("agent");
      expect(explain.sources.map(source => source.source)).toEqual(["user", "project", "env", "cli"]);
      expect(explain.conflicts.some(conflict => conflict.key === "api_key")).toBe(false);
      expect(explain.conflicts.some(conflict => conflict.key === "mode" && conflict.winner === "project")).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("does not produce negative input costs when cached tokens exceed input tokens", () => {
    expect(calculateCost("deepseek-v4-pro", 10, 0, 20)).toBeGreaterThanOrEqual(0);
  });

  it("migrates legacy config keys without changing conflicting canonical keys", () => {
    const userConfig = join(process.env.HOME!, ".seekcode", "config.toml");
    mkdirSync(join(process.env.HOME!, ".seekcode"), { recursive: true });
    writeFileSync(userConfig, [
      'apiKey = "legacy"',
      'api_key = "canonical"',
      'baseUrl = "http://legacy.local"',
      "",
    ].join("\n"));

    const report = migrateUserConfig();
    const migrated = readFileSync(userConfig, "utf-8");

    expect(report.warnings.join("\n")).toContain("apiKey");
    expect(report.actions.join("\n")).toContain("baseUrl");
    expect(migrated).toContain("api_key");
    expect(migrated).toContain("base_url");
    expect(migrated).not.toContain("apiKey");
  });

  it("validates semantic config errors and explains source conflicts", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    const projectDir = join(tmp, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), 'model = "user-model"\n[[mcp_servers]]\nname = "bad"\ntransport = "stdio"\n');
    writeFileSync(join(projectDir, "config.toml"), 'model = "project-model"\n');
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const validation = validateConfig();
      const explain = explainConfig();

      expect(validation.ok).toBe(false);
      expect(validation.issues.some(issue => issue.key === "mcp_servers.0.command")).toBe(true);
      expect(explain.conflicts.some(conflict => conflict.key === "model" && conflict.winner === "project")).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("loads, migrates, and validates web configuration", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), [
      "[web]",
      "enabled = true",
      'searchEngine = "duckduckgo"',
      'allowedDomains = ["example.com"]',
      'blocked_domains = ["blocked.example"]',
      'googleApiKey = "google-user-key"',
      'googleCx = "google-cx"',
      'exaApiKey = "exa-user-key"',
      'kagiApiKey = "kagi-user-key"',
      'braveApiKey = "brave-user-key"',
      'semanticScholarApiKey = "s2-user-key"',
      'pubmedApiKey = "pubmed-user-key"',
      'searxngUrl = "https://search.example"',
      'proxy = "http://proxy.example:8080"',
      "searchTimeoutMs = 2500",
      "",
    ].join("\n"));

    const report = migrateUserConfig();
    const cfg = loadConfig();
    const validation = validateConfig();

    expect(report.actions.join("\n")).toContain("web.searchEngine");
    expect(cfg.web.search_engine).toBe("duckduckgo");
    expect(cfg.web.allowed_domains).toEqual(["example.com"]);
    expect(cfg.web.blocked_domains).toEqual(["blocked.example"]);
    expect(cfg.web.google_api_key).toBe("google-user-key");
    expect(cfg.web.google_cx).toBe("google-cx");
    expect(cfg.web.exa_api_key).toBe("exa-user-key");
    expect(cfg.web.kagi_api_key).toBe("kagi-user-key");
    expect(cfg.web.brave_api_key).toBe("brave-user-key");
    expect(cfg.web.semantic_scholar_api_key).toBe("s2-user-key");
    expect(cfg.web.pubmed_api_key).toBe("pubmed-user-key");
    expect(cfg.web.searxng_url).toBe("https://search.example");
    expect(cfg.web.proxy).toBe("http://proxy.example:8080");
    expect(cfg.web.search_timeout_ms).toBe(2500);
    expect(validation.ok).toBe(true);
  });

  it("rejects invalid web proxy config", () => {
    const userDir = join(process.env.HOME!, ".seekcode");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.toml"), [
      "[web]",
      'proxy = "socks5://proxy.example:1080"',
      "",
    ].join("\n"));

    const validation = validateConfig();

    expect(validation.ok).toBe(false);
    expect(validation.issues.some(issue => issue.key === "web.proxy")).toBe(true);
  });
});

describe("skills system", () => {
  it("discovers workspace skills before global skills and injects metadata only", () => {
    const home = join(tmp, "home-skills");
    const workspaceSkill = join(tmp, ".agents", "skills", "demo");
    const globalSkill = join(home, ".seekcode", "skills", "demo");
    mkdirSync(workspaceSkill, { recursive: true });
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(workspaceSkill, "SKILL.md"), skillMd("demo", "workspace skill", "workspace body secret"));
    writeFileSync(join(globalSkill, "SKILL.md"), skillMd("demo", "global skill", "global body secret"));

    const result = scanSkills(tmp, home, { includeSystem: false });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].description).toBe("workspace skill");
    expect(result.errors.some(error => error.includes("duplicate skill 'demo'"))).toBe(true);
  });

  it("activates a skill for the next user request", () => {
    const dir = join(tmp, "skills", "writer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd("writer", "write carefully", "Always use short sentences."));

    const activated = activateSkill("writer", { workspaceDir: tmp, skillsDir: join(tmp, "skills") });
    const input = applySkillToUserInput("draft this", activated.instruction!);

    expect(activated.ok).toBe(true);
    expect(input).toContain("Always use short sentences.");
    expect(input).toContain("User request:\ndraft this");
  });

  it("installs, trusts, and uninstalls a skill from a safe archive", () => {
    const archive = tarGz([
      { path: "repo-main/good/SKILL.md", data: skillMd("good", "safe skill", "Do good work.") },
      { path: "repo-main/good/references/info.txt", data: "reference" },
    ]);

    const installed = installSkillFromArchive(archive, "github:owner/repo", join(tmp, "installed"));
    const trusted = trustSkill("good", { workspaceDir: tmp, skillsDir: join(tmp, "installed") });

    expect(installed.name).toBe("good");
    expect(existsSync(join(installed.path, "references", "info.txt"))).toBe(true);
    expect(trusted).toContain("Trusted skill");
    const uninstalled = uninstallSkill("good", { skillsDir: join(tmp, "installed") });
    expect(uninstalled).toContain("Uninstalled skill");
    expect(existsSync(installed.path)).toBe(false);
  });

  it("rejects skill archives with traversal or symlink entries", () => {
    const traversal = tarGz([
      { path: "repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
      { path: "../escape.txt", data: "escape" },
    ]);
    const symlink = tarGz([
      { path: "repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
      { path: "repo-main/skill/link", data: "", type: "2", linkname: "/etc/passwd" },
    ]);

    expect(() => installSkillFromArchive(traversal, "x", join(tmp, "installed"))).toThrow(/escapes destination/);
    expect(() => installSkillFromArchive(symlink, "x", join(tmp, "installed"))).toThrow(/symlinks/);
  });

  it("applies skill precedence across workspace, project, configured, and compat roots", () => {
    const configured = join(tmp, "configured-skills");
    const workspaceSkill = join(tmp, ".agents", "skills", "same");
    const projectSkill = join(tmp, ".seekcode", "skills", "project-only");
    const configuredSkill = join(configured, "configured-only");
    const configuredDuplicate = join(configured, "same");
    const compatSkill = join(process.env.HOME!, ".claude", "skills", "compat-only");
    mkdirSync(workspaceSkill, { recursive: true });
    mkdirSync(projectSkill, { recursive: true });
    mkdirSync(configuredSkill, { recursive: true });
    mkdirSync(configuredDuplicate, { recursive: true });
    mkdirSync(compatSkill, { recursive: true });
    writeFileSync(join(workspaceSkill, "SKILL.md"), skillMd("same", "workspace wins", "workspace body"));
    writeFileSync(join(configuredDuplicate, "SKILL.md"), skillMd("same", "configured loses", "configured body"));
    writeFileSync(join(projectSkill, "SKILL.md"), skillMd("project-only", "project skill", "project body"));
    writeFileSync(join(configuredSkill, "SKILL.md"), skillMd("configured-only", "configured skill", "configured body"));
    writeFileSync(join(compatSkill, "SKILL.md"), skillMd("compat-only", "compat skill", "compat body"));

    const registry = scanSkills(tmp, process.env.HOME!, { skillsDir: configured, includeSystem: false });
    const names = registry.skills.map(skill => skill.name).sort();

    expect(names).toEqual(["compat-only", "configured-only", "project-only", "same"]);
    expect(registry.skills.find(skill => skill.name === "same")?.description).toBe("workspace wins");
    expect(registry.errors.some(error => error.includes("duplicate skill 'same'"))).toBe(true);
  });

  it("rejects absolute, prefixed traversal, and NUL skill archive entries", () => {
    const absolute = tarGz([
      { path: "/repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
    ]);
    const prefixedTraversal = tarGz([
      { path: "repo-main/skill/SKILL.md", data: skillMd("bad", "bad skill", "bad") },
      { path: "repo-main/skill/../escape.txt", data: "escape" },
    ]);
    const nulBody = tarGz([
      { path: "repo-main/nul/SKILL.md", data: skillMd("nul", "nul skill", "body\0hidden") },
    ]);

    expect(() => installSkillFromArchive(absolute, "x", join(tmp, "installed"))).toThrow(/escapes destination|missing SKILL/);
    expect(() => installSkillFromArchive(prefixedTraversal, "x", join(tmp, "installed"))).toThrow(/escapes destination/);
    expect(() => installSkillFromArchive(nulBody, "x", join(tmp, "installed"))).toThrow(/NUL byte/);
  });

  it("trusts the highest-precedence matching skill and activation uses trusted body", () => {
    const workspaceSkill = join(tmp, "skills", "trusted-demo");
    const globalSkill = join(process.env.HOME!, ".seekcode", "skills", "trusted-demo");
    mkdirSync(workspaceSkill, { recursive: true });
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(workspaceSkill, "SKILL.md"), skillMd("trusted-demo", "workspace trusted", "workspace trusted body"));
    writeFileSync(join(globalSkill, "SKILL.md"), skillMd("trusted-demo", "global ignored", "global body"));

    const trusted = trustSkill("trusted-demo", { workspaceDir: tmp, skillsDir: join(process.env.HOME!, ".seekcode", "skills") });
    const activated = activateSkill("trusted-demo", { workspaceDir: tmp, skillsDir: join(process.env.HOME!, ".seekcode", "skills") });

    expect(trusted).toContain("Trusted skill");
    expect(existsSync(join(workspaceSkill, ".trusted"))).toBe(true);
    expect(existsSync(join(globalSkill, ".trusted"))).toBe(false);
    expect(activated.instruction).toContain("workspace trusted body");
    expect(activated.instruction).not.toContain("global body");
  });
});

describe("P1 tool system", () => {
  it("stores and reads artifacts through artifact tools", async () => {
    registerArtifactTools();

    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "run.log", content: "hello artifact" }));
    const listed = await getRegistry().lookup("artifact_list")!.execute({ kind: "log" });
    const read = await getRegistry().lookup("artifact_read")!.execute({ id: created.id });

    expect(listed).toContain(created.id);
    expect(read).toContain("hello artifact");
  });

  it("writes MCP server config and toggles enabled state", async () => {
    registerDiagnosticsTools();

    const added = await getRegistry().lookup("mcp_manager")!.execute({ action: "add", name: "demo", command: process.execPath, args: ["server.js"] });
    const disabled = await getRegistry().lookup("mcp_manager")!.execute({ action: "disable", name: "demo" });
    const enabled = await getRegistry().lookup("mcp_manager")!.execute({ action: "enable", name: "demo" });
    const config = readFileSync(join(process.env.HOME!, ".seekcode", "config.toml"), "utf-8");

    expect(added).toContain("demo");
    expect(disabled).toContain("\"enabled\": false");
    expect(enabled).toContain("\"enabled\": true");
    expect(config).toContain("mcp_servers");
    expect(config).toContain("demo");
  });

  it("reports MCP health failures with per-server log artifacts", async () => {
    registerDiagnosticsTools();
    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "bad",
      command: process.execPath,
      args: ["-e", "console.error('mcp boom'); process.exit(1)"],
    });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });

    const health = await getRegistry().lookup("mcp_manager")!.execute({ action: "health", name: "bad" });

    expect(health).toContain("failed");
    expect(health).toContain("log_artifact_id");
  });

  it("connects MCP servers, hot-refreshes tools, and unregisters tools after crashes", async () => {
    registerDiagnosticsTools();
    const stateFile = join(tmp, "mcp-state.json");
    const serverFile = join(tmp, "mcp-server.mjs");
    writeFileSync(stateFile, JSON.stringify({ tools: ["alpha"] }));
    writeFileSync(serverFile, mcpServerScript(stateFile));

    await getRegistry().lookup("mcp_manager")!.execute({
      action: "add",
      name: "hot",
      command: process.execPath,
      args: [serverFile],
    });
    const reloaded = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    const alpha = getRegistry().lookup("mcp_hot_alpha");
    expect(reloaded.servers.find((server: any) => server.name === "hot")).toMatchObject({ status: "connected", tool_count: 1 });
    expect(alpha).toBeTruthy();
    expect(await alpha!.execute({ value: "one" })).toContain("alpha:{\"value\":\"one\"}");

    writeFileSync(stateFile, JSON.stringify({ tools: ["beta"] }));
    const manager = getMCPManager();
    const refreshed = await manager.refreshTools(manager.list().find(server => server.name === "hot")!);

    expect(refreshed).toBe(true);
    expect(getRegistry().lookup("mcp_hot_alpha")).toBeUndefined();
    expect(getRegistry().lookup("mcp_hot_beta")).toBeTruthy();
    expect(await getRegistry().lookup("mcp_hot_beta")!.execute({ value: "two" })).toContain("beta:{\"value\":\"two\"}");

    await getRegistry().lookup("mcp_hot_beta")!.execute({ crash: true });
    await waitFor(() => getRegistry().lookup("mcp_hot_beta") ? null : true);
    const health = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "health", name: "hot" }));

    expect(health.hot.status).toBe("failed");
    expect(health.hot.stderr_tail).toContain("mcp crash requested");
    expect(health.hot.log_artifact_id).toBeTruthy();
  });

  it("persists MCP add/disable/enable/remove and applies enabled state after reload", async () => {
    registerDiagnosticsTools();
    const serverFile = join(tmp, "disabled-mcp.mjs");
    const stateFile = join(tmp, "disabled-state.json");
    writeFileSync(stateFile, JSON.stringify({ tools: ["noop"] }));
    writeFileSync(serverFile, mcpServerScript(stateFile));

    await getRegistry().lookup("mcp_manager")!.execute({ action: "add", name: "toggle", command: process.execPath, args: [serverFile] });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "disable", name: "toggle" });
    const disabled = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    await getRegistry().lookup("mcp_manager")!.execute({ action: "enable", name: "toggle" });
    const enabled = JSON.parse(await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" }));
    const noop = getRegistry().lookup("mcp_toggle_noop");
    const removed = await getRegistry().lookup("mcp_manager")!.execute({ action: "remove", name: "toggle" });
    await getRegistry().lookup("mcp_manager")!.execute({ action: "reload" });

    expect(disabled.servers.find((server: any) => server.name === "toggle")).toMatchObject({ status: "disabled" });
    expect(getRegistry().lookup("mcp_toggle_noop")).toBeUndefined();
    expect(enabled.servers.find((server: any) => server.name === "toggle")).toMatchObject({ status: "connected" });
    expect(noop).toBeTruthy();
    expect(removed).toContain("\"removed\": \"toggle\"");
    expect(getRegistry().lookup("mcp_toggle_noop")).toBeUndefined();
  });

  it("runs TypeScript diagnostics and archives output", async () => {
    registerDiagnosticsTools();
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.8.0" } }));
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
    writeFileSync(join(tmp, "bad.ts"), "const x: number = 'bad';\n");

    const result = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "typescript" }));

    expect(result.language).toBe("typescript");
    expect(result.artifact_id).toBeTruthy();
    expect(String(result.output)).toContain("bad.ts");
  });

  it("parses and filters diagnostics across LSP-style output shapes", async () => {
    registerDiagnosticsTools();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const fakePyright = join(bin, "pyright");
    writeFileSync(fakePyright, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      JSON.stringify({
        generalDiagnostics: [
          {
            file: join(tmp, "src", "keep.py"),
            severity: "error",
            message: "bad assignment",
            rule: "reportAssignmentType",
            range: { start: { line: 2, character: 4 } },
          },
          {
            file: join(tmp, "src", "skip.py"),
            severity: "information",
            message: "informational only",
            range: { start: { line: 4, character: 2 } },
          },
          {
            file: join(tmp, "src", "keep.py"),
            severity: "hint",
            message: "hint kept when all",
            range: { start: { line: 7, character: 1 } },
          },
        ],
      }),
      "JSON",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(fakePyright)}`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const errors = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({
        workdir: tmp,
        language: "python",
        files: ["src/keep.py"],
        min_severity: "error",
      }));
      const all = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({
        workdir: tmp,
        language: "python",
        files: ["src/keep.py"],
        min_severity: "all",
      }));

      expect(errors.summary).toEqual({ total: 1, by_severity: { error: 1 } });
      expect(errors.diagnostics[0]).toMatchObject({ file: join(tmp, "src", "keep.py"), line: 3, column: 5, severity: "error", code: "reportAssignmentType" });
      expect(all.summary).toEqual({ total: 2, by_severity: { error: 1, hint: 1 } });
      expect(all.diagnostics.map((diagnostic: any) => diagnostic.message)).toContain("hint kept when all");
      expect(all.diagnostics.map((diagnostic: any) => diagnostic.file)).not.toContain(join(tmp, "src", "skip.py"));
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("parses TypeScript, Go, and Rust diagnostic text formats", async () => {
    registerDiagnosticsTools();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tsc"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"src/app.ts(12,8): error TS2322: Type '\\\"x\\\"' is not assignable to type 'number'.\"",
      "printf '%s\\n' \"src/app.ts(13,1): warning TS6133: 'unused' is declared but its value is never read.\"",
    ].join("\n"));
    writeFileSync(join(bin, "gopls"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' 'main.go:3:5: error: undefined: nope'",
    ].join("\n"));
    writeFileSync(join(bin, "cargo"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' 'src/main.rs:4:9: warning: unused variable: `x`'",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(join(bin, "tsc"))} ${JSON.stringify(join(bin, "gopls"))} ${JSON.stringify(join(bin, "cargo"))}`);
    writeFileSync(join(tmp, "package.json"), "{}");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const ts = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "typescript", min_severity: "all" }));
      const go = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "go", min_severity: "all" }));
      const rust = JSON.parse(await getRegistry().lookup("lsp_diagnostics")!.execute({ workdir: tmp, language: "rust", min_severity: "all" }));

      expect(ts.summary).toEqual({ total: 2, by_severity: { error: 1, warning: 1 } });
      expect(ts.diagnostics[0]).toMatchObject({ file: "src/app.ts", line: 12, column: 8, severity: "error", code: "TS2322" });
      expect(go.diagnostics[0]).toMatchObject({ file: "main.go", line: 3, column: 5, severity: "error", message: "undefined: nope" });
      expect(rust.diagnostics[0]).toMatchObject({ file: "src/main.rs", line: 4, column: 9, severity: "warning", message: "unused variable: `x`" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("blocks GitHub mutations on dirty worktrees and records evidence", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "dirty.txt"), "dirty\n");

    const result = await getRegistry().lookup("github_comment")!.execute({ number: "1", body: "hello", workdir: tmp });

    expect(result).toContain("dirty worktree guard");
    expect(result).toContain("Evidence artifact:");
  });

  it("does not misclassify verified GitHub targets whose title contains error-like words", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, ".gitignore"), "artifacts/\nhome/\ngh-calls.log\n");
    const bin = join(tmp, "bin");
    const calls = join(tmp, "gh-calls.log");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
      "if [[ \"$1 $2\" == \"issue view\" ]]; then",
      "  printf '%s\\n' '{\"number\":1,\"title\":\"Error page copy\",\"state\":\"OPEN\",\"url\":\"https://example.invalid/1\"}'",
      "  exit 0",
      "fi",
      "if [[ \"$1 $2\" == \"issue comment\" ]]; then",
      "  printf '%s\\n' 'comment created'",
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"));
    await run(`chmod +x ${JSON.stringify(join(bin, "gh"))}`);
    await run("git add .gitignore bin/gh && git commit -m fake-gh");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath || ""}`;
    try {
      const result = await getRegistry().lookup("github_comment")!.execute({ number: "1", body: "hello", workdir: tmp });

      expect(result).toBe("comment created");
      expect(readFileSync(calls, "utf-8")).toContain("issue view");
      expect(readFileSync(calls, "utf-8")).toContain("issue comment");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("keeps PR attempt record faithful for empty diffs", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file.txt"), "stable\n");
    await run("git add . && git commit -m init");

    const recorded = JSON.parse(await getRegistry().lookup("pr_attempt_record")!.execute({ workdir: tmp }));
    const patch = await getRegistry().lookup("pr_attempt_read")!.execute({ id: recorded.artifact_id });

    expect(recorded.bytes).toBe(0);
    expect(patch).not.toContain("(exit 0)");
  });

  it("archives PR attempt patches in the artifact store", async () => {
    registerDiagnosticsTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file.txt"), "old\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "file.txt"), "new\n");

    const recorded = JSON.parse(await getRegistry().lookup("pr_attempt_record")!.execute({ workdir: tmp }));
    const listed = await getRegistry().lookup("pr_attempt_list")!.execute({});
    const read = await getRegistry().lookup("pr_attempt_read")!.execute({ id: recorded.artifact_id });

    expect(recorded.artifact_id).toBeTruthy();
    expect(listed).toContain(recorded.artifact_id);
    expect(read).toContain("+new");
  });

  it("runs PR attempt gates and records rollback evidence", async () => {
    registerDiagnosticsTools();
    registerArtifactTools();
    await run("git init");
    await run("git config user.email test@example.com");
    await run("git config user.name Tester");
    writeFileSync(join(tmp, "file.txt"), "old\n");
    await run("git add . && git commit -m init");
    writeFileSync(join(tmp, "file.txt"), "new\n");

    const gate = JSON.parse(await getRegistry().lookup("pr_attempt_gate")!.execute({ workdir: tmp, command: "test -f file.txt" }));
    const failedGate = JSON.parse(await getRegistry().lookup("pr_attempt_gate")!.execute({ workdir: tmp, command: "test -f missing.txt" }));
    const rollback = JSON.parse(await getRegistry().lookup("pr_attempt_rollback")!.execute({ workdir: tmp, target: "HEAD" }));
    const rollbackLog = await getRegistry().lookup("artifact_read")!.execute({ id: rollback.artifact_id });

    expect(gate.passed).toBe(true);
    expect(failedGate.passed).toBe(false);
    expect(gate.artifact_id).toBeTruthy();
    expect(failedGate.artifact_id).toBeTruthy();
    expect(rollback.artifact_id).toBeTruthy();
    expect(readFileSync(join(tmp, "file.txt"), "utf-8")).toBe("old\n");
    expect(rollbackLog).toContain("[before]");
    expect(rollbackLog).toContain("[after]");
  });

  it("links artifacts to replay targets", async () => {
    registerArtifactTools();
    const created = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "evidence", name: "e.txt", content: "proof" }));
    await getRegistry().lookup("artifact_link")!.execute({ id: created.id, scope: "turn", target_id: "session1:1" });

    expect(listArtifactLinks({ scope: "turn", target_id: "session1:1" })[0].artifact_id).toBe(created.id);
    expect(await getRegistry().lookup("artifact_links")!.execute({ scope: "turn" })).toContain(created.id);
  });

  it("keeps artifact index separate from artifact records and truncates large reads safely", async () => {
    registerArtifactTools();
    const first = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "first.log", content: "a".repeat(32) }));
    const second = JSON.parse(await getRegistry().lookup("artifact_create")!.execute({ kind: "log", name: "second.log", content: "b".repeat(32) }));
    await getRegistry().lookup("artifact_link")!.execute({ id: first.id, scope: "session", target_id: "s1" });

    const listed = JSON.parse(await getRegistry().lookup("artifact_list")!.execute({ limit: 10 }));
    const read = await getRegistry().lookup("artifact_read")!.execute({ id: second.id, max_bytes: 5 });

    expect(listed.map((record: any) => record.id).sort()).toEqual([first.id, second.id].sort());
    expect(listed.every((record: any) => record.id && record.kind && record.path)).toBe(true);
    expect(read).toContain("\"truncated\": true");
    expect(read).toContain("\"total_bytes\": 32");
    expect(read.endsWith("bbbbb")).toBe(true);
  });
});

async function run(command: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  execSync(command, { cwd: tmp, stdio: "ignore" });
}

function tempPatchFiles(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(tmpdir()).filter(name => name.startsWith("deepseek-patch-")).sort();
}

function testConfig(): Config {
  return {
    api_key: "",
    base_url: "http://localhost",
    model: "deepseek-v4-pro",
    flash_model: "deepseek-v4-flash",
    mode: "agent",
    max_tokens: 128,
    max_turns: 3,
    context_limit: 950_000,
    reasoning_effort: "off",
    rollback_enabled: false,
    cost_tracking: true,
    thinking_visible: true,
    tui_alternate_screen: "never",
    mcp_servers: [],
    skills_dir: join(tmp, "home", ".seekcode", "skills"),
    skills_registry_url: "https://example.com/skills.json",
    skills_max_install_size_bytes: 5 * 1024 * 1024,
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
    status_items: ["mode", "model", "workspace", "context", "cache", "tools", "elapsed", "cost", "hints"],
  };
}

function skillMd(name: string, description: string, body: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function tarGz(entries: Array<{ path: string; data: string; type?: string; linkname?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data, "utf-8");
    const type = entry.type || "0";
    const size = type === "0" ? data.length : 0;
    const header = Buffer.alloc(512, 0);
    writeTarString(header, 0, 100, entry.path);
    writeTarString(header, 100, 8, "0000644");
    writeTarString(header, 108, 8, "0000000");
    writeTarString(header, 116, 8, "0000000");
    writeTarString(header, 124, 12, size.toString(8).padStart(11, "0"));
    writeTarString(header, 136, 12, "00000000000");
    header.fill(0x20, 148, 156);
    writeTarString(header, 156, 1, type);
    if (entry.linkname) writeTarString(header, 157, 100, entry.linkname);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    if (size > 0) {
      blocks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value.slice(0, length), offset, Math.min(length, Buffer.byteLength(value)), "utf-8");
}

class FakeClient extends DeepSeekClient {
  private batches: StreamEvent[][];
  lastSignal?: AbortSignal;
  calls: Array<{ messages: any; tools: any; options?: { signal?: AbortSignal } }> = [];

  constructor(events: Array<StreamEvent | StreamEvent[]>) {
    super({ apiKey: "test", baseUrl: "http://localhost", model: "test" });
    this.batches = events.map(event => Array.isArray(event) ? event : [event]);
  }

  override async *send(messages?: any, tools?: any, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
    this.lastSignal = options?.signal;
    this.calls.push({ messages, tools, options });
    const batch = this.batches.shift() ?? [];
    for (const event of batch) {
      if (options?.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      yield event;
    }
  }
}

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 1500): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for condition");
}

function mcpServerScript(stateFile: string): string {
  return `
import { readFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
function tools() {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    return (state.tools || []).map((name) => ({
      name,
      description: name + " tool",
      inputSchema: { type: "object", properties: { value: { type: "string" }, crash: { type: "boolean" } } },
    }));
  } catch {
    return [];
  }
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, { protocolVersion: "2024-11-05", capabilities: {} });
    } else if (request.method === "tools/list") {
      respond(request.id, { tools: tools() });
    } else if (request.method === "tools/call") {
      const args = request.params?.arguments || {};
      if (args.crash) {
        console.error("mcp crash requested");
        process.exit(42);
      }
      respond(request.id, { content: [{ type: "text", text: request.params.name + ":" + JSON.stringify(args) }] });
    } else {
      respond(request.id, {});
    }
  }
});
`;
}
