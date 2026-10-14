# Contract: the MCP transport and the internal seams

**Feature**: `074-mcp-server`. Protocol facts come from
[`docs/research/mcp.md`](../../../docs/research/mcp.md); items marked **[confirm]** there
must be read from `node_modules/@modelcontextprotocol/sdk` before `protocol.ts` is written.

## 1. The route — `src/app/api/mcp/route.ts`

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response>   // the MCP endpoint
export async function GET(): Promise<Response>                    // 405
export async function DELETE(): Promise<Response>                 // 405
```

`POST` delegates to `handleMcpRequest(request)` and returns its `Response`. The route holds
no logic, exactly as `src/app/api/v1/[[...path]]/route.ts` holds none.

Required of the POST handler, from `docs/research/mcp.md` §2:

- answer with a single `application/json` JSON-RPC response (never SSE);
- if an `Origin` header is present and is not an allowed origin, answer **403**;
- honour the `MCP-Protocol-Version` header rule of the revision the SDK implements
  (**[confirm]**: the exact rule, the `_meta` field name and the error code);
- hold no session state: the key is resolved on every request.

## 2. `src/server/mcp/protocol.ts` — the only protocol-aware file

```ts
/** NEEDS DEPENDENCY: @modelcontextprotocol/sdk */
export async function handleMcpRequest(request: Request): Promise<Response>;
```

Owns the JSON-RPC envelope, `initialize`, `tools/list`, `tools/call`, the
`CallToolResult` shape and the protocol-level error responses. Calls, and only calls:

```ts
listTools(scope): McpTool[]           // describe.ts + dispositions.ts
callTool(name, args, request): Promise<McpToolOutcome>   // bridge.ts
```

## 3. `src/server/mcp/dispositions.ts` — the derived surface (no protocol, no IO)

```ts
export const EXPOSED: readonly AnyApiOperation[];     // from OPERATIONS, order = table order
export const WITHHELD: readonly { id: string; reason: string }[];
export function dispositionProblems(ops: readonly AnyApiOperation[]): string[];
```

`dispositionProblems` returns one human-readable problem per malformed or missing
disposition, naming the operation id. The drift test asserts it is empty for `OPERATIONS`
and non-empty, naming the right id, for a fixture table with a disposition removed.

## 4. `src/server/mcp/naming.ts`

```ts
export function toolNameFor(operationId: string): string;   // docket_ + snake_case
export const PUBLISHED_TOOL_NAMES: readonly string[];       // the frozen nineteen
```

## 5. `src/server/mcp/schema.ts`

```ts
export function argumentSchemaFor(op: AnyApiOperation, confirm?: McpConfirm): z.ZodObject;
export function inputSchemaFor(op: AnyApiOperation, confirm?: McpConfirm): Record<string, unknown>;
export function argumentNamesFor(op: AnyApiOperation): { params: string[]; query: string[]; body: string[] };
```

`inputSchemaFor` is `z.toJSONSchema(…, { target: "draft-2020-12", io: "input",
unrepresentable: "any" })` with local `$ref`s inlined and `$defs`/`$schema` removed.
`argumentNamesFor` exists so the bridge can route each argument to the path, the query or
the body, and so the collision test has something to compare.

## 6. `src/server/mcp/describe.ts`

```ts
export function describeTool(op: AnyApiOperation, project: { name: string }, confirm?: McpConfirm): string;
export function toolsFor(scope: ProjectScope): McpTool[];
```

Four required parts per [data-model.md §5](../data-model.md), using
`errorStatuses`/`codesFor` from `src/server/api/error-surface.ts`.

## 7. `src/server/mcp/bridge.ts` — the pipeline bridge

```ts
export interface McpToolOutcome {
  status: number;
  body: unknown;
  isError: boolean;
  /** `Retry-After` and `Idempotent-Replayed` when the pipeline set them. */
  headers: Record<string, string>;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  request: Request,       // the MCP request, for its credential headers only
): Promise<McpToolOutcome>;
```

Order of work, and the reason for the order:

1. resolve the tool by name — unknown name is a protocol-level error, not a tool result;
2. reject unknown arguments (`validation_failed`, naming the field);
3. check `confirm` (`confirmation_required`, naming the effect and the argument) — **before
   anything is sent**, so a refused call has no side effect and no rate-limit cost;
4. validate `idempotencyKey` only by passing it on; the pipeline owns its rules;
5. build the `Request`: filled path, query string, JSON body, the credential headers copied
   from the MCP request, `Idempotency-Key` when given;
6. `await handleApiRequest(built, segments)`;
7. read the status, parse the JSON body, pick up `Retry-After` and
   `Idempotent-Replayed`, and set `isError` from `status >= 400`.

The bridge never reads the DAL, never touches the database and never constructs a
`ProjectScope`. Steps 1–3 happen without any IO at all.

## 8. `src/server/api/error-surface.ts` — extracted, behaviour unchanged

```ts
export function errorStatuses(op: AnyApiOperation): number[];
export function codesForStatus(status: number): ApiErrorCode[];
```

`src/server/api/openapi.ts` imports both and keeps its own markdown formatting.
`tests/integration/api/openapi.test.ts` must stay green with no edit — that is the proof
the extraction changed nothing.

## 9. Authentication seam, and why a tool call is counted once

`initialize` and `tools/list` resolve the key with `forApiKey(key)`: they are requests that
do work, and that call is what counts them against the key's per-minute limit. It also
gives `tools/list` the project name its descriptions need.

A `tools/call` **must not** call `forApiKey` in the MCP layer, because `forApiKey` always
increments the rate-limit window (`countRequest`, `src/server/dal/api-keys.ts:185`) and the
pipeline is about to resolve the key again — a tool call would cost two of the key's sixty
requests a minute and halve its effective limit over MCP. So the order is:

1. `readKey(request.headers)` plus the key's shape check (`isWellFormedApiKey`) — no
   database access. Absent, malformed or conflicting credentials are refused
   `invalid_api_key` here, exactly as the HTTP pipeline refuses them (FR-009).
2. the unknown-argument and `confirm` checks, which are static per tool and disclose
   nothing about the project;
3. `handleApiRequest`, which performs the one counting resolution and therefore owns the
   `invalid_api_key` answer for a well-formed key that is unknown, revoked or expired.

**The one ordered consequence, stated plainly**: a *well-formed but revoked* key calling a
confirmation tool without `confirm` is answered `confirmation_required` rather than
`invalid_api_key`. Nothing is disclosed (the confirmation rule is published documentation
and the message is static), nothing is written, and the key is refused the moment it asks
for anything real. The alternative — authenticating first — either doubles the rate-limit
cost of every tool call or adds a second, non-counting key resolver to the DAL.
