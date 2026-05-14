# MCP (Model Context Protocol) Integration

Seek Code supports connecting to MCP servers to extend tooling capabilities.

## Configuration

Add MCP servers to your configuration file:

### `.seekcode/config.toml` (project-local)

```toml
[[mcp_servers]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]

[[mcp_servers]]
name = "github"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_..." }

[[mcp_servers]]
name = "remote-tools"
transport = "sse"
url = "https://example.com/mcp"
```

### Transport Types

- **stdio**: MCP server runs as a subprocess. Communication via stdin/stdout JSON-RPC.
- **sse**: MCP server runs remotely. Communication via HTTP SSE + POST.

## How It Works

1. On startup, Seek Code connects to all configured MCP servers
2. Each server provides its list of tools
3. Tools are registered in the global tool registry with prefix `mcp_<server>_<tool>`
4. The model can call MCP tools like any other tool
5. Permission level for MCP tools is `ASK` by default

## Manual Control

Use slash commands during a session:

```text
/mcp list              List connected MCP servers and their tools
/mcp add <name> ...    Add a new stdio MCP server
/mcp disable <name>    Disable an MCP server
/mcp reload            Reload configured MCP servers
```

Legacy `.deepseek/config.toml` can be migrated with `seek config migrate --target project`.
