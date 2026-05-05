import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageInfo = {
  name: string;
  version: string;
};

function readPackageInfo(): PackageInfo {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../package.json"),
    resolve(here, "../../package.json"),
    resolve(process.cwd(), "package.json"),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as Partial<PackageInfo>;
      if (typeof parsed.name === "string" && typeof parsed.version === "string") {
        return { name: parsed.name, version: parsed.version };
      }
    } catch {
      // Keep looking from other likely runtime locations.
    }
  }

  return { name: "seekcode", version: "0.0.0" };
}

export const PACKAGE_INFO = readPackageInfo();
export const PACKAGE_NAME = PACKAGE_INFO.name;
export const VERSION = PACKAGE_INFO.version;
