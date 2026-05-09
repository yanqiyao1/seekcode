import {
  addMCPServer,
  getMCPManager,
  reloadMCPManager,
  removeMCPServer,
  setMCPServerEnabled,
} from "../mcp/manager.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";

export const mcpCommand: SlashCommandHandler = async ({ cfg, parts, write }) => {
  const subcmd = parts[1] || "list";
  try {
    if (subcmd === "list") {
      write(JSON.stringify(getMCPManager(cfg).list(), null, 2));
      return;
    }
    if (subcmd === "reload") {
      const manager = await reloadMCPManager(cfg);
      write(JSON.stringify({ reloaded: true, servers: manager.list() }, null, 2));
      return;
    }
    if (subcmd === "enable" || subcmd === "disable") {
      const name = parts[2];
      if (!name) {
        write(p.error("Usage: /mcp enable|disable <name>"));
        return;
      }
      setMCPServerEnabled(name, subcmd === "enable");
      write(p.success(`${subcmd === "enable" ? "Enabled" : "Disabled"} MCP server ${name}. Run /mcp reload to apply.`));
      return;
    }
    if (subcmd === "remove" || subcmd === "delete") {
      const name = parts[2];
      if (!name) {
        write(p.error("Usage: /mcp remove <name>"));
        return;
      }
      removeMCPServer(name);
      write(p.success(`Removed MCP server ${name}. Run /mcp reload to apply.`));
      return;
    }
    if (subcmd === "add") {
      const name = parts[2];
      const command = parts[3];
      if (!name || !command) {
        write(p.error("Usage: /mcp add <name> <command> [args...]"));
        return;
      }
      addMCPServer({ name, transport: "stdio", command, args: parts.slice(4), env: {}, enabled: true });
      write(p.success(`Added MCP server ${name}. Run /mcp reload to apply.`));
      return;
    }
    write(p.error("Usage: /mcp [list|add|enable|disable|remove|reload]"));
  } catch (e: any) {
    write(p.error(`MCP error: ${e.message}`));
  }
};

