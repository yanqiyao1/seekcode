import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { loadConfig } from "../src/config.js";
import { buildPinnedPrefix } from "../src/engine/prefix-builder.js";
import { registerBuiltInTools } from "../src/tools/setup.js";
import { getRegistry } from "../src/tools/registry.js";

interface BenchResult {
  name: string;
  duration_ms: number;
  detail?: string;
}

const results: BenchResult[] = [];

function measure<T>(name: string, fn: () => T, detail?: (value: T) => string | undefined): T {
  const start = performance.now();
  const value = fn();
  results.push({ name, duration_ms: performance.now() - start, detail: detail?.(value) });
  return value;
}

async function measureAsync<T>(name: string, fn: () => Promise<T>, detail?: (value: T) => string | undefined): Promise<T> {
  const start = performance.now();
  const value = await fn();
  results.push({ name, duration_ms: performance.now() - start, detail: detail?.(value) });
  return value;
}

const tmp = mkdtempSync(join(tmpdir(), "seekcode-bench-"));
try {
  process.env.HOME = join(tmp, "home");
  const workspace = join(tmp, "workspace");
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "AGENTS.md"), "Benchmark project instructions.\n");
  for (let i = 0; i < 250; i++) {
    writeFileSync(join(workspace, "src", `file-${i}.ts`), `export function bench${i}() { return ${i}; }\n`);
  }

  const cfg = measure("config.load", () => loadConfig({ api_key: "bench-key" }), cfg => `${cfg.model}/${cfg.mode}`);
  const registry = measure("tools.register", () => registerBuiltInTools(cfg, { clear: true }), registry => `${registry.size} tools`);
  measure("prefix.build", () => buildPinnedPrefix(cfg, workspace, registry), prefix => `${prefix.metadata.tool_count} schemas`);
  measure("file.rg_files", () => spawnSync("rg", ["--files", workspace], { encoding: "utf-8" }), result => {
    if (result.error) return `skipped: ${result.error.message}`;
    return `${result.stdout.split("\n").filter(Boolean).length} files`;
  });
  await measureAsync("file.search_tool", () => getRegistry().lookup("search")!.execute({ path: workspace, pattern: "bench249" }), output => `${output.length} chars`);
  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
  getRegistry().clear();
}
