import type { AnyApiOperation } from "../../src/server/api/operations";
import { callTool, type McpToolOutcome } from "../../src/server/mcp/bridge";
import { toolNameFor } from "../../src/server/mcp/naming";
import type { world } from "./api";
import { FIXTURES } from "./api-fixtures";

type Project = Awaited<ReturnType<typeof world>>["a"];

export interface McpCallOptions {
  confirm?: true;
  idempotencyKey?: string;
  /** Applied after the fixture's own params/query/body, e.g. to swap in a foreign resource id. */
  overrides?: Record<string, unknown>;
}

/** Flattens a fixture's params/query/body into the one argument object a tool call takes, and drives `callTool` directly (no protocol layer). */
export async function mcpCall(
  op: AnyApiOperation,
  p: Project,
  key: string | undefined,
  opts: McpCallOptions = {},
): Promise<McpToolOutcome> {
  const fx = FIXTURES[op.id]!;
  const params = fx.params?.(p) ?? {};
  const bodyRaw = fx.body ? await fx.body(p) : undefined;
  const body = bodyRaw instanceof FormData || bodyRaw === undefined ? {} : (bodyRaw as Record<string, unknown>);
  const query = fx.query ? Object.fromEntries(new URLSearchParams(fx.query)) : {};
  const args: Record<string, unknown> = { ...params, ...query, ...body, ...opts.overrides };
  if (opts.confirm) args.confirm = true;
  if (opts.idempotencyKey !== undefined) args.idempotencyKey = opts.idempotencyKey;

  const headers = new Headers();
  if (key) headers.set("authorization", `Bearer ${key}`);
  const request = new Request("http://localhost/mcp", { method: "POST", headers });
  return callTool(toolNameFor(op.id), args, request);
}
