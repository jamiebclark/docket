import { readKey } from "@/server/api/auth";
import { apiError, ApiError } from "@/server/api/errors";
import { handleApiRequest } from "@/server/api/handle";
import type { AnyApiOperation } from "@/server/api/operations/types";
import { errorBody } from "@/server/api/respond";
import { isWellFormedApiKey } from "@/server/dal/api-keys";
import { EXPOSED } from "./dispositions";
import { toolNameFor } from "./naming";
import { argumentNamesFor } from "./schema";

export interface McpToolOutcome {
  status: number;
  body: unknown;
  isError: boolean;
  /** `Retry-After` and `Idempotent-Replayed` when the pipeline set them. */
  headers: Record<string, string>;
}

const BY_NAME = new Map(EXPOSED.map((op) => [toolNameFor(op.id), op] as const));

function fillPath(op: AnyApiOperation, params: Record<string, string>): string {
  return op.path.replace(/\{(\w+)\}/g, (_m, name: string) => encodeURIComponent(params[name] ?? ""));
}

function outcomeFor(e: ApiError): McpToolOutcome {
  return { status: e.status, body: errorBody(e, ""), isError: true, headers: e.headers ?? {} };
}

/** Raised by `callTool` for a tool name no `McpTool` has — a protocol-level error, not a tool result. */
export class UnknownToolError extends Error {
  constructor(override readonly name: string) {
    super(`unknown tool: ${name}`);
  }
}

/** Tool call -> `Request` -> `handleApiRequest` -> tool result (contracts/mcp-transport.md §7). */
export async function callTool(name: string, args: Record<string, unknown>, request: Request): Promise<McpToolOutcome> {
  const op = BY_NAME.get(name);
  if (!op) throw new UnknownToolError(name);

  // No-DB credential shape check, ahead of the confirm check: an absent/malformed/conflicting key is refused
  // the same way a request with no confirmation requirement would be, and before it costs the key anything.
  const key = readKey(request.headers);
  if (key === null || key === "conflict" || !isWellFormedApiKey(key)) {
    return outcomeFor(apiError("invalid_api_key", "Invalid API key.", undefined, { "WWW-Authenticate": "Bearer" }));
  }

  const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
  const names = argumentNamesFor(op);
  const known = new Set<string>([...names.params, ...names.query, ...names.body]);
  if (confirm) known.add("confirm");
  if (op.idempotent) known.add("idempotencyKey");
  for (const key of Object.keys(args)) {
    if (!known.has(key)) return outcomeFor(apiError("validation_failed", `Unknown argument: ${key}`, { field: key }));
  }

  if (confirm) {
    const required = confirm.when ? confirm.when(args) : true;
    if (required && args.confirm !== true) {
      return outcomeFor(
        apiError("confirmation_required", `Requires confirm: true. ${confirm.effect}`, { argument: "confirm", effect: confirm.effect }),
      );
    }
  }

  const params: Record<string, string> = {};
  for (const n of names.params) if (args[n] !== undefined) params[n] = String(args[n]);
  const url = new URL(`http://localhost${fillPath(op, params)}`);
  for (const n of names.query) {
    const v = args[n];
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(n, String(item));
    else url.searchParams.set(n, String(v));
  }

  const bodyObj: Record<string, unknown> = {};
  for (const n of names.body) if (args[n] !== undefined) bodyObj[n] = args[n];
  const hasBody = op.body !== undefined;

  const headers = new Headers();
  const auth = request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) headers.set("x-api-key", apiKeyHeader);
  if (hasBody) headers.set("content-type", "application/json");
  if (typeof args.idempotencyKey === "string") headers.set("idempotency-key", args.idempotencyKey);

  const built = new Request(url, {
    method: op.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(bodyObj) } : {}),
  });
  const segments = url.pathname.split("/").filter(Boolean);
  const response = await handleApiRequest(built, segments);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const outHeaders: Record<string, string> = {};
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) outHeaders["Retry-After"] = retryAfter;
  const replayed = response.headers.get("idempotent-replayed");
  if (replayed !== null) outHeaders["Idempotent-Replayed"] = replayed;

  return { status: response.status, body, isError: response.status >= 400, headers: outHeaders };
}
