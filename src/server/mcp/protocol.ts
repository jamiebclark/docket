import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { readKey } from "@/server/api/auth";
import { InvalidApiKeyError } from "@/server/dal/errors";
import { forApiKey } from "@/server/dal/scope";
import { callTool, UnknownToolError, type McpToolOutcome } from "./bridge";
import { toolsFor } from "./describe";
import type { McpTool } from "./types";

/**
 * No legitimate caller of this endpoint is a browser: there is no CORS configuration anywhere
 * else in the app, and every documented client (docs/n8n.md's pattern, docs/mcp.md) is a
 * server-side or desktop MCP client that sends no `Origin` header at all. So any `Origin`
 * present is disallowed (docs/research/mcp.md §2's "403 for an invalid Origin").
 */
function originRejection(request: Request): Response | undefined {
  if (request.headers.get("origin") === null) return undefined;
  return new Response(JSON.stringify({ error: "Origin header is not allowed on this endpoint." }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function headersFrom(info: { headers: Record<string, string | string[] | undefined> } | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(info?.headers ?? {})) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/** `invalid_api_key` at the protocol level: no tool ran, so this is a JSON-RPC error, not a tool result (contracts/mcp-transport.md §9). */
async function authenticate(headers: Headers) {
  const key = readKey(headers);
  if (key === null || key === "conflict") throw new McpError(ErrorCode.InvalidRequest, "Invalid API key.");
  try {
    return await forApiKey(key);
  } catch (e) {
    if (e instanceof InvalidApiKeyError) throw new McpError(ErrorCode.InvalidRequest, "Invalid API key.");
    throw e;
  }
}

/**
 * `McpToolOutcome.headers` carries `Retry-After`/`Idempotent-Replayed` lifted from the pipeline's
 * response; a `CallToolResult` has no header channel, so both are folded into the serialised body
 * (research D14, D6) rather than dropped on the floor.
 */
function bodyWithHeaders(outcome: McpToolOutcome): unknown {
  let body = outcome.body;
  const retryAfter = outcome.headers["Retry-After"];
  if (retryAfter !== undefined && body && typeof body === "object" && "error" in body) {
    const error = (body as { error: Record<string, unknown> }).error;
    body = { ...body, error: { ...error, retryAfterSeconds: Number(retryAfter) } };
  }
  if (outcome.headers["Idempotent-Replayed"] !== undefined && body && typeof body === "object") {
    body = { ...body, alreadyReplayed: true };
  }
  return body;
}

function toToolDefinition(tool: McpTool): Record<string, unknown> {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema };
}

function newServer(): Server {
  const server = new Server({ name: "docket", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const { scope } = await authenticate(headersFrom(extra.requestInfo));
    return { tools: toolsFor(scope).map(toToolDefinition) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const mcpRequest = new Request("http://localhost/api/mcp", { headers: headersFrom(extra.requestInfo) });
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const outcome = await callTool(request.params.name, args, mcpRequest);
      return { content: [{ type: "text", text: JSON.stringify(bodyWithHeaders(outcome)) }], isError: outcome.isError };
    } catch (e) {
      if (e instanceof UnknownToolError) throw new McpError(ErrorCode.MethodNotFound, e.message);
      throw e;
    }
  });

  return server;
}

/** The only protocol-aware entry point (contracts/mcp-transport.md §2). Stateless: a fresh `Server`/transport pair per request. */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const rejected = originRejection(request);
  if (rejected) return rejected;

  const server = newServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
  }
}
