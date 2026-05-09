import { explainConfig, migrateProjectConfig, migrateUserConfig, validateConfig } from "../config.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";

export const configCommand: SlashCommandHandler = ({ parts, write }) => {
  const subcmd = parts[1] || "explain";
  if (subcmd === "validate") {
    const report = validateConfig();
    write(JSON.stringify(report, null, 2));
    return;
  }
  if (subcmd === "migrate") {
    const target = parts[2] || "user";
    const dryRun = parts.includes("--dry-run");
    const report = target === "project" ? migrateProjectConfig({ dryRun }) : migrateUserConfig({ dryRun });
    write(JSON.stringify(report, null, 2));
    return;
  }
  if (subcmd === "explain") {
    write(JSON.stringify(explainConfig(), null, 2));
    return;
  }
  write(p.error("Usage: /config [validate|migrate user|migrate project|explain] [--dry-run]"));
};

