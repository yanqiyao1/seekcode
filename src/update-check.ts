import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { PACKAGE_NAME, VERSION } from "./version.js";
import { p } from "./ui/palette.js";

type TTYInput = NodeJS.ReadableStream & { isTTY?: boolean };
type TTYOutput = NodeJS.WritableStream & { isTTY?: boolean };

export type UpdateCheckResult = "disabled" | "current" | "skipped" | "updated" | "failed";

export type UpdateCheckOptions = {
  packageName?: string;
  currentVersion?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: TTYInput;
  stdout?: TTYOutput;
  fetchLatestVersion?: (packageName: string, timeoutMs: number) => Promise<string | null>;
  installLatest?: (packageName: string) => Promise<number>;
};

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shouldCheckForUpdates(options: Pick<UpdateCheckOptions, "env" | "stdin" | "stdout"> = {}): boolean {
  const env = options.env || process.env;
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (isTruthyEnv(env.CI)) return false;
  if (isTruthyEnv(env.SEEKCODE_SKIP_UPDATE_CHECK)) return false;
  if (isTruthyEnv(env.NO_UPDATE_NOTIFIER)) return false;
  return true;
}

function parseVersionTuple(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersionTuple(left);
  const b = parseVersionTuple(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export async function fetchLatestNpmVersion(packageName: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile("npm", ["view", packageName, "version", "--silent"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const latest = String(stdout || "").trim().split(/\s+/)[0];
      resolve(latest || null);
    });
  });
}

async function installLatestWithNpm(packageName: string): Promise<number> {
  return new Promise(resolve => {
    const child = spawn("npm", ["install", "-g", `${packageName}@latest`], { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", code => resolve(code ?? 1));
  });
}

export async function maybePromptForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  if (!shouldCheckForUpdates({ env: options.env, stdin, stdout })) return "disabled";

  const packageName = options.packageName || PACKAGE_NAME;
  const currentVersion = options.currentVersion || VERSION;
  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchLatest = options.fetchLatestVersion || fetchLatestNpmVersion;
  const latestVersion = await fetchLatest(packageName, timeoutMs);
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) return "current";

  stdout.write(`\n${p.warning(`Seek Code ${latestVersion} is available. Current version: ${currentVersion}.`)}\n`);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const answer = (await rl.question(`Update now with npm install -g ${packageName}@latest? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      stdout.write(`${p.dim("Skipped update for now.")}\n`);
      return "skipped";
    }
  } finally {
    rl.close();
  }

  const installLatest = options.installLatest || installLatestWithNpm;
  const code = await installLatest(packageName);
  if (code === 0) {
    stdout.write(`${p.success(`Updated ${packageName}. Restart seek to use the new version.`)}\n`);
    return "updated";
  }
  stdout.write(`${p.warning(`Update failed. You can retry with: npm install -g ${packageName}@latest`)}\n`);
  return "failed";
}
