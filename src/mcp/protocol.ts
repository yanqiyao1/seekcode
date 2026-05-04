/** MCP JSON-RPC 2.0 protocol types. */

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id: string;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createRequest(method: string, params: Record<string, unknown> = {}): JSONRPCRequest {
  return { jsonrpc: "2.0", method, params, id: Math.random().toString(36).slice(2, 10) };
}
