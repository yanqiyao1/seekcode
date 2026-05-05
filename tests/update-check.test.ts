import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { compareVersions, maybePromptForUpdate, shouldCheckForUpdates } from "../src/update-check.js";

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
});
