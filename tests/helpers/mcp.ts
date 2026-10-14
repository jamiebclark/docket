// The MCP route module, loaded lazily like tests/helpers/api.ts's ROUTE.
const ROUTE = "../../src/app/api/mcp/route";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcResult {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Drives `POST /api/mcp` in-process with a real JSON-RPC request (no listening server). */
async function rpc(method: string, params: Record<string, unknown>, key?: string): Promise<{ status: number; body: JsonRpcResult }> {
  const mod = (await import(/* @vite-ignore */ ROUTE)) as Record<string, (req: Request) => Promise<Response>>;
  const handler = mod.POST;
  if (!handler) throw new Error("route module has no POST handler");
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (key) headers.set("authorization", `Bearer ${key}`);
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const response = await handler(request);
  const text = await response.text();
  const body = (text ? JSON.parse(text) : null) as JsonRpcResult;
  return { status: response.status, body };
}

/** A real `tools/list` through the route. */
export async function mcpToolsList(key?: string): Promise<{ status: number; result?: { tools: McpTool[] }; error?: JsonRpcResult["error"] }> {
  const { status, body } = await rpc("tools/list", {}, key);
  return { status, result: body.result as { tools: McpTool[] } | undefined, error: body.error };
}

export interface McpCallResult {
  status: number;
  /** Present when the request reached a tool: `CallToolResult.content[0].text`, parsed as JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests assert on arbitrary response shapes
  body?: any;
  isError?: boolean;
  /** Set for a protocol-level failure (unknown tool, bad credential shape): no tool ran. */
  error?: JsonRpcResult["error"];
}

/** A real `tools/call` through the route. */
export async function mcpToolsCall(name: string, args: Record<string, unknown>, key?: string): Promise<McpCallResult> {
  const { status, body } = await rpc("tools/call", { name, arguments: args }, key);
  if (body.error) return { status, error: body.error };
  const result = body.result as { content: { type: "text"; text: string }[]; isError?: boolean };
  const text = result.content[0]?.text ?? "null";
  return { status, body: JSON.parse(text), isError: result.isError ?? false };
}
