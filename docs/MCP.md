# MCP (Model Context Protocol) Integration

DeepSeek CLI supports connecting to MCP servers to extend tooling capabilities.

## Configuration

Add MCP servers to your configuration file:

### `.deepseek/config.toml` (project-local)

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

1. On startup, DeepSeek CLI connects to all configured MCP servers
2. Each server provides its list of tools
3. Tools are registered in the global tool registry with prefix `mcp_<server>_<tool>`
4. The model can call MCP tools like any other tool
5. Permission level for MCP tools is `ASK` by default

## Manual Control

Use slash commands during a session:

```
/mcp_connect <config>   Connect to a new MCP server
/mcp_disconnect <name>  Disconnect from an MCP server
/mcp_list              List connected MCP servers and their tools
```
