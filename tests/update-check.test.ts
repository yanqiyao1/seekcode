import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertMinimumVersion,
  compareVersions,
  detectInstallation,
  getUpdateLockPath,
  maybePromptForUpdate,
  prepareUpdateCheck,
  promptForPreparedUpdate,
  runUpdateCommand,
  shouldCheckForUpdates,
  type InstallationInfo,
} from "../src/update-check.js";

const repoRoot = resolve(".");

let tmp: string;
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-update-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(tmp, { recursive: true, force: true });
});

function ttyInput(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = new PassThrough() as NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = true;
  stream.end(text);
  return stream;
}

function ttyOutput(): NodeJS.WritableStream & { isTTY?: boolean; chunks: string[] } {
  const stream = new PassThrough() as NodeJS.WritableStream & { isTTY?: boolean; chunks: string[] };
  stream.isTTY = true;
  stream.chunks = [];
  stream.on("data", chunk => stream.chunks.push(String(chunk)));
  return stream;
}

describe("update checker", () => {
  it("compares package versions without a hardcoded current version", () => {
    expect(compareVersions("0.1.4", "0.1.3")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  it("does not check in non-interactive or CI contexts", () => {
    const stdin = { isTTY: false } as NodeJS.ReadableStream & { isTTY?: boolean };
    const stdout = { isTTY: true } as NodeJS.WritableStream & { isTTY?: boolean };

    expect(shouldCheckForUpdates({ stdin, stdout })).toBe(false);
    expect(shouldCheckForUpdates({ stdin: { isTTY: true } as any, stdout, env: { CI: "1" } as any })).toBe(false);
    expect(shouldCheckForUpdates({ stdin: { isTTY: true } as any, stdout, env: { SEEKCODE_SKIP_UPDATE_CHECK: "1" } as any })).toBe(false);
  });

  it("prompts and runs npm install only when the user accepts", async () => {
    const output = ttyOutput();
    const installs: string[] = [];
    const result = await maybePromptForUpdate({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput("y\n"),
      stdout: output,
      fetchLatestVersion: async () => "0.1.4",
      installLatest: async packageName => {
        installs.push(packageName);
        return 0;
      },
    });

    expect(result).toBe("updated");
    expect(installs).toEqual(["seekcode"]);
    expect(output.chunks.join("")).toContain("0.1.4");
  });

  it("lets the user skip an available update", async () => {
    const result = await maybePromptForUpdate({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput("\n"),
      stdout: ttyOutput(),
      fetchLatestVersion: async () => "0.1.4",
      installLatest: async () => {
        throw new Error("install should not run");
      },
    });

    expect(result).toBe("skipped");
  });

  it("prepares update checks without prompting until the prepared result is consumed", async () => {
    const output = ttyOutput();
    const installs: string[] = [];
    const installation: InstallationInfo = {
      kind: "global",
      packageName: "seekcode",
      packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
      executablePath: join(tmp, "prefix", "bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: null,
      updateCommand: "npm install -g seekcode@latest",
      canAutoUpdate: true,
      reason: "test global install",
    };

    const prepared = await prepareUpdateCheck({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput(""),
      stdout: output,
      fetchLatestVersion: async () => "0.1.4",
      detectInstallation: async () => installation,
    });

    expect(prepared).toMatchObject({ result: "available", latestVersion: "0.1.4" });
    expect(output.chunks.join("")).toBe("");

    const result = await promptForPreparedUpdate(prepared, {
      stdin: ttyInput("y\n"),
      stdout: output,
      installLatest: async packageName => {
        installs.push(packageName);
        return 0;
      },
    });

    expect(result).toBe("updated");
    expect(installs).toEqual(["seekcode"]);
    expect(output.chunks.join("")).toContain("0.1.4");
  });

  it("detects source checkout installs as dev installs", async () => {
    const info = await detectInstallation({
      modulePath: join(repoRoot, "src", "update-check.ts"),
      executablePath: join(repoRoot, "src", "index.ts"),
      npmPrefix: join(tmp, "npm-prefix"),
    });

    expect(info.kind).toBe("dev");
    expect(info.canAutoUpdate).toBe(false);
    expect(info.updateCommand).toContain("npm run build");
  });

  it("runs local npm updates from the owning project root", async () => {
    const projectRoot = join(tmp, "consumer");
    const info: InstallationInfo = {
      kind: "local",
      packageName: "seekcode",
      packageRoot: join(projectRoot, "node_modules", "seekcode"),
      executablePath: join(projectRoot, "node_modules", ".bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: projectRoot,
      updateCommand: "npm install seekcode@latest",
      canAutoUpdate: true,
      reason: "test local install",
    };
    const installs: Array<{ command: string; args: string[]; cwd: string }> = [];

    const result = await runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      packageName: "seekcode",
      yes: true,
      stdout: ttyOutput(),
      stderr: ttyOutput(),
      detectInstallation: async () => info,
      installPackage: async (command, args, cwd) => {
        installs.push({ command, args, cwd });
        return 0;
      },
    });

    expect(result).toBe("updated");
    expect(installs).toEqual([{ command: "npm", args: ["install", "seekcode@latest"], cwd: projectRoot }]);
  });

  it("uses ~/.seekcode/.update.lock to prevent concurrent updates", async () => {
    const lockPath = getUpdateLockPath();
    mkdirSync(join(process.env.HOME!, ".seekcode"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, started_at: new Date().toISOString() }));
    const installs: unknown[] = [];
    const info: InstallationInfo = {
      kind: "global",
      packageName: "seekcode",
      packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
      executablePath: join(tmp, "prefix", "bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: null,
      updateCommand: "npm install -g seekcode@latest",
      canAutoUpdate: true,
      reason: "test global install",
    };

    const result = await runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      packageName: "seekcode",
      yes: true,
      stdout: ttyOutput(),
      stderr: ttyOutput(),
      detectInstallation: async () => info,
      installPackage: async (...args) => {
        installs.push(args);
        return 0;
      },
    });

    expect(result).toBe("locked");
    expect(installs).toEqual([]);
  });

  it("enforces minimum version gates except for the update command", () => {
    expect(() => assertMinimumVersion({
      currentVersion: "0.1.0",
      env: { SEEKCODE_MIN_VERSION: "0.2.0" } as any,
    })).toThrow(/seek update/i);
    expect(() => assertMinimumVersion({
      currentVersion: "0.1.0",
      commandName: "update",
      env: { SEEKCODE_MIN_VERSION: "0.2.0" } as any,
    })).not.toThrow();
  });
});
