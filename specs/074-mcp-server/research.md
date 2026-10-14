# Phase 0 research: An MCP server over the v1 API

**Feature**: `074-mcp-server` | **Date**: 2026-10-14 | **Spec**: [spec.md](./spec.md)

Every fact below is read out of this repository or out of `docs/research/mcp.md`. Nothing
is taken from memory (constitution I). Each decision names what was chosen, why, and what
was rejected.

## Unknowns from the spec, and their resolution

| Spec constraint | Status |
|---|---|
| 1. MCP protocol facts absent from `docs/research/` | **Partly resolved.** `docs/research/mcp.md` now exists, citing the official specification for the transport, the tool shape, the result shape and the authorization convention. The handshake fields, the JSON-RPC error codes and the SDK's own API stay `NEEDS RESEARCH` and must be read from the installed package's types; they are confined to one file (D3). |
| 2. No MCP library installed | **Unchanged. `NEEDS DEPENDENCY: @modelcontextprotocol/sdk`.** Confirmed absent from `package.json` and from `node_modules/` in both the worktree and the main checkout. Only the protocol file depends on it (D3). |
| 3. Filter beside the table vs. derived surface | **Resolved**: exposure is a required field on `ApiOperation` (D1). |
| 4. No `listPosts` operation | **Confirmed.** `OPERATIONS` has `getPost` and `getPostTarget` by id, and no list. Recorded as a gap for a later API entry (D15); nothing is added here. |
| 5. `uploadMedia` is multipart | **Confirmed**: `src/server/api/operations/media.ts:92-106`, `body.kind: "multipart"`. Withheld on mechanical grounds. |
| 6. `getOpenApi` has no permission | **Confirmed**: `src/server/api/operations/openapi.ts:10`, `permission: null`. Withheld. |
| 7. `Idempotency-Key` is a header | **Confirmed**: `src/server/api/handle.ts` reads `request.headers.get("idempotency-key")` and only then calls `runIdempotent`. Resolved by D6 (an argument the bridge turns back into the header). |
| 8. Rate limit is per key per minute | **Confirmed**: `forApiKey` returns `rate.count`/`rate.limit`/`rate.resetAt` and `handle.ts` answers `rate_limited` with `Retry-After`. Nothing to add — the bridge goes through the same code. |
| 9. A key is pinned to one project | **Confirmed**: `api_keys.project_id` is `NOT NULL`; `forApiKey(key)` builds the scope around that project. The project rule is therefore inherited, not invented (D5). |
| 10. `auto_approve` grants only `generation: ["auto_approve"]` | **Confirmed**: `src/server/dal/scope.ts:97`. No operation declares it as `permission`, so it changes what `generatePost` does, not whether a tool is callable. Said out loud in the generate tool's description (D9). |

## Code facts this entry stands on

- **One operation table.** `src/server/api/operations/index.ts` exports `OPERATIONS`,
  concatenated from eleven files. 34 operations today, counted from the table.
- **One pipeline, reachable with a `Request`.** `handleApiRequest(request, segments)`
  (`src/server/api/handle.ts`) does the whole job: `readKey` → `forApiKey` → rate limit →
  permission check → body read → `parseInput` → `runIdempotent` (writes with the header) →
  `mapServiceError`. The route module is a seven-line wrapper
  (`src/app/api/v1/[[...path]]/route.ts`). **A caller that can build a `Request` gets the
  entire pipeline with no new code** — this is what makes FR-011 and SC-009 structural.
- **One error shape.** `API_ERROR_CODES`, `statusFor`, `ApiError`, `mapServiceError`,
  `errorBody` (`src/server/api/errors.ts`, `respond.ts`). `confirmation_required` is
  **already** in `API_ERROR_CODES` with status 400 — the confirmation refusal needs no new
  code (FR-020).
- **Per-operation failure derivation already exists** but is private: `errorStatuses(op)`
  and `codesFor(status)` in `src/server/api/openapi.ts:40,66`. FR-006 asks the tool
  descriptions to use "the same logic", so these move to a shared module (D8).
- **Zod can emit JSON Schema with no new dependency.** `zod@4.6.5` exports
  `z.toJSONSchema` (`node_modules/zod/v4/core/json-schema-processors.d.cts:59`) with
  `target`, `io`, `unrepresentable`, `metadata`, `reused` and `override` parameters
  (`node_modules/zod/v4/core/to-json-schema.d.cts`). Verified by running it against a
  schema shaped like a real operation's: `io: "input"` renders `z.coerce.number()` as
  `{"type":"integer"}`, `z.literal(true)` as `{"type":"boolean","const":true}`, and
  extracts any `.meta({ id })` sub-schema into `$defs` with a local `$ref` unless an empty
  metadata registry is passed (which also drops every `description`). Hence D7.
- **The test harness already drives the route with a `Request`.** `tests/helpers/api.ts`
  `api(method, path, { key, body, idem })` imports the route module and calls it; `world()`
  builds two fully populated projects (A and B) plus one key per permission.
- **One fixture per operation already exists.** `tests/integration/api/scope-enforcement.test.ts`
  holds `FIXTURES: Record<string, Fixture>` with an entry for all 33 keyed operations, a
  test that fails when an operation has no fixture, and `call(op, project, key, override)`.
  Reusing it is how the MCP suite avoids a second parallel fixture list (D11).
- **The secret scan has a list of route calls** to add to:
  `tests/integration/security/secret-scan.test.ts`, `routeCalls` (around line 364),
  already including two `/api/v1` calls, one with a bad key.
- **The import boundary is linted by path.** `tests/lint/api-imports.test.ts` checks
  `src/server/api/**` imports no database client and `src/server/api/operations/**` plus
  `src/app/api/v1/**` import no DAL for data access. `src/server/mcp/**` is new and must be
  added to the same lists (D12).

## Decisions

### D1 — Exposure is a required field on `ApiOperation`

`ApiOperation` gains a required `mcp` field (`src/server/api/operations/types.ts`):

```ts
type McpDisposition =
  | { expose: true }
  | { expose: true; confirm: McpConfirm }
  | { expose: false; reason: string };
```

**Chosen** because a filter living beside the table is the hand-maintained parallel list
the entry exists to remove (spec constraint 3), and because a required field makes
`defineOperation` fail to compile without a decision — so the decision is made in the same
edit that adds the operation (FR-001, FR-002, SC-002).

**Rejected**: a `Set<string>` of exposed ids (a new operation silently inherits the
default); deriving exposure from `permission` or `tag` (`read` covers withheld job reads,
`write_posts` covers both `createPost` and the recovery operations — no predicate
separates them); an `x-mcp-*` extension on the OpenAPI document (the document is built
*from* the table, so it is the wrong place to hold a fact about the table).

**Compile-time versus run-time**: the required field is enforced by `pnpm typecheck`. The
drift test cannot "add an operation without a disposition" in TypeScript, so it asserts the
same rule at run time over `OPERATIONS` (every entry has a well-formed `mcp`) and over a
local fixture table whose missing field is cast away — which is what Story 3's
acceptance 1 describes.

### D2 — A route in the Next app: `POST /api/mcp`

Three containers today (web, worker, postgres; `docs/deployment.md`). The MCP layer needs
`forApiKey`, the rate-limit counter, the permission check, the idempotency table and
`mapServiceError`, all of which live in the web process. A second process would either
duplicate them or call the web process over the very HTTP API it translates.

`src/app/api/mcp/route.ts` exports `POST` (and `GET`/`DELETE` answering 405, per
`docs/research/mcp.md` §2). `runtime = "nodejs"`, `dynamic = "force-dynamic"`, copied from
the v1 route. No new infrastructure, so constitution VI needs no exception beyond the one
dependency (D3).

**Accepted cost**: a long-lived MCP connection shares the web container with the UI. Since
the server never streams (D4), there is no long-lived connection in practice — a tool call
is one POST.

**Rejected**: a separate process (new container, duplicated auth, or self-HTTP);
`/api/v1/mcp` (MCP is not a v1 REST operation and must not appear in the OpenAPI
document or the v1 router).

### D3 — The SDK supplies the wire format; one file speaks it

`src/server/mcp/protocol.ts` is the only file that imports `@modelcontextprotocol/sdk`.
It owns: the `initialize` handshake, protocol-version negotiation and the
`MCP-Protocol-Version` header rule, the `tools/list` and `tools/call` dispatch, the
JSON-RPC envelope and the `CallToolResult` shape. Everything else in `src/server/mcp/`
is protocol-free and unit-testable without the package.

Primary approach: use the SDK's server/transport. If its transport cannot be driven from a
WHATWG `Request` (Next.js route handlers receive one; the SDK's streamable-HTTP transport
is documented against Node `req`/`res` — `docs/research/mcp.md` §2 **[confirm]**), the
fallback is to implement the single POST endpoint in this same file using the SDK's own
exported Zod schemas and types for every message. That is not hand-rolling a substitute
(constitution VI): the message definitions still come from the package, and only the
`Request`→`Response` plumbing is ours.

**Rejected**: `mcp-handler` or another Next.js wrapper (a second dependency for plumbing
we can write in one file, and it would not remove the SDK dependency); writing the protocol
from memory (constitution I forbids it).

### D4 — One JSON object per POST; no SSE, no session, no server-initiated work

Docket's tools answer requests and send nothing unprompted: no sampling, no elicitation,
no resources, no prompts, no progress notifications. The specification permits answering a
POST with a single `application/json` object (`docs/research/mcp.md` §2), so the route is
request/response only and holds no per-connection state.

**Why it matters beyond simplicity**: no session means the key is resolved per request,
exactly as over HTTP, which is what makes "a key revoked mid-session is refused on the next
request" true by construction rather than by a session-invalidation mechanism.

**Rejected**: SSE streaming (nothing to stream); stateful sessions (a revoked key would
need explicit eviction, and the known stateless/`validateSession` trouble in the SDK's
transport, recorded in `docs/research/mcp.md` §2, is avoided entirely).

### D5 — The key decides the project; authentication precedes `tools/list`

`readKey(request.headers)` is called on the MCP request exactly as `handle.ts` calls it, so
`Authorization: Bearer dkt_…` and `X-API-Key: dkt_…` both work and a cookie is never read.
The scope comes from `forApiKey`, so the project is the key's project (spec constraint 9).

`tools/list` is authenticated for the same reason `tools/call` is: the descriptions name the
project (FR-006), so listing discloses it. An absent, malformed, revoked or expired key is
refused with `invalid_api_key` for both (FR-009). `tools/list` resolves the key itself; a
`tools/call` checks the credential is present and well formed and lets the pipeline do the
one resolution that counts against the rate limit (D16).

**Where the refusal goes**: `initialize` and `tools/list` failures are JSON-RPC errors (no
tool ran, so there is no tool result to put `isError` in); a `tools/call` failure is a tool
result with `isError: true` carrying the API error body, so the model can see it and correct
itself (`docs/research/mcp.md` §3). Both carry the same code, message and request id.

**Rejected**: an unauthenticated `tools/list` showing a generic surface (two description
generators, and the project-naming requirement would have to be dropped); a separate MCP
credential or an ambient browser session (FR-008, FR-010).

### D6 — The bridge builds a `Request` and calls `handleApiRequest`

A tool call becomes:

1. the operation's `path` with `{param}` filled from the arguments, URL-encoded;
2. a query string built from the arguments that belong to `op.query` (scalars via
   `String(v)`, arrays repeated);
3. a JSON body of the arguments that belong to `op.body` (omitted when the operation has
   no body);
4. headers: the key as `Authorization: Bearer …`, `Content-Type: application/json` when
   there is a body, and `Idempotency-Key` when the caller passed the idempotency argument;
5. `handleApiRequest(new Request(url, { method: op.method, headers, body }), segments)`.

The response's status, JSON body and `Retry-After`/`Idempotent-Replayed` headers become the
tool result. **For a tool call, nothing in the MCP layer resolves the key, counts the rate limit,
checks a permission, parses an operation's input, stores an idempotency record or maps a
service error** (D16) — FR-011
is a property of the design, and FR-014/SC-009 reduce to "the same arguments produce the same
answer", which the equivalence test asserts for every exposed tool.

**Rejected**: calling `op.run(scope, …)` directly (skips authentication, the rate limit, the
permission check, `parseInput` and `runIdempotent` — a second implementation of the pipeline,
and the thing FR-011 forbids); `fetch()` to the app's own origin (a real socket, a second TLS
hop, and the origin is not knowable inside a route handler); refactoring `handle.ts` into
smaller exported steps (a bigger change to the one file every v1 request already goes
through, for no gain — it already takes a `Request`).

**Cost accepted**: one `Request` object and one JSON serialise/parse per tool call. That is
cheaper than the LLM round trip that caused it, and it buys byte-identical behaviour.

### D7 — Tool arguments are one flat object; the JSON Schema is derived and self-contained

The input schema is the merge of `op.params`, `op.query` and `op.body.schema` shapes, plus
`confirm` where the disposition asks for it and `idempotencyKey` where `op.idempotent` is
true. Flat, because a model writes `{"postId": "…", "at": "…"}` far more reliably than
`{"params": {...}, "body": {...}}`, and because FR-005 describes a flat field set.

Emitted with
`z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" })`
and then **inlined**: every local `$ref` is replaced by its `$defs` entry and `$defs` and
`$schema` are dropped, so each tool's `inputSchema` is a self-contained object. Verified
necessary: a body schema carrying `.meta({ id })` (most of `src/lib/api/schemas.ts`) otherwise
emits `$defs` + `$ref`. Inlining keeps every `description` (an empty metadata registry
inlines too, but drops them — measured) and client JSON Schema support for `$ref` is uneven.
No request body in the table is recursive, so inlining terminates; a future cyclic schema
makes `z.toJSONSchema` throw (`cycles: "throw"` is the default), which the drift test surfaces
by operation id rather than at a client.

A name collision between a path parameter, a query field and a body field would silently
merge two different things. None exists today; a test asserts it for the whole table, so a
future collision fails the suite instead of shipping.

**Unknown arguments are rejected by the MCP layer**, with `validation_failed` naming the
field. The flattened namespace exists only in MCP, and not every body schema is a
`z.strictObject` (`src/lib/api/schemas.ts` uses both), so Zod would strip an invented key
rather than refuse it — which the spec's edge case forbids.

**Rejected**: nesting by source (unfriendly to a model, and not what FR-005 says);
hand-written JSON Schema per tool (FR-005 forbids a duplicate); `outputSchema` per tool
(derived from `op.responses` it would be large and is not required by any FR; the result is
returned as JSON text and, where the SDK supports it, as `structuredContent`).

### D8 — `errorStatuses` and `codesFor` move to a shared module

Both become exports of `src/server/api/error-surface.ts`, imported by `openapi.ts` (whose
behaviour must not change — `tests/integration/api/openapi.test.ts` guards it) and by the
MCP description generator. FR-006's "the same per-operation logic the OpenAPI document uses"
is then literally the same function, and `codesFor` is split so the description can list
codes in plain text while the document keeps its backticked markdown.

**Rejected**: duplicating the derivation in the MCP layer (it would drift the first time an
error code is added — exactly what FR-006 is written to prevent); exporting them from
`openapi.ts` (the MCP layer would then import the whole document builder, including
`zod-openapi`, to generate a sentence).

### D9 — Four confirmations, plus a conditional fifth on `generatePost`

`queuePost`, `schedulePost`, `deleteSlot` and `createProject` require `confirm: true`
(FR-021). The argument accepts only the JSON literal `true`: `z.literal(true)`, which
renders as `{"type":"boolean","const":true}`, so `"true"`, `1`, `false` and omission are all
the same refusal, and the refusal is `confirmation_required` (already in `API_ERROR_CODES`)
naming the effect and the argument. The check runs **before** the `Request` is built, so
nothing reaches the pipeline and there is no side effect.

**The fifth is a deviation from the spec's text and is flagged for review.** The spec's
Decisions say "generation is exposed without confirmation", but `generatePost`'s body
accepts `schedulingPolicy: "add_to_queue"`
(`src/server/api/operations/generate.ts:22`, `src/lib/validation/policies.ts:4`), and that
queues the generated post to the brand's live accounts in the same call. FR-020 is a MUST
about *effects*, not about operation ids, and FR-021's list names the effects
("queueing a post"). So `docket_generate_post` requires `confirm: true` **only when its
arguments ask for queueing** (`schedulingPolicy` present and not `leave_as_draft`), and is
otherwise unconfirmed as the spec describes. The disposition expresses this as
`confirm: { when: (args) => … , effect: "…" }`, so it is declared on the operation like the
other four rather than special-cased in the bridge.

Reversing this is a one-line change to that operation's disposition if review prefers the
spec's literal reading; the cost of the literal reading is that the only unconfirmed path to
a live publish over MCP is the generate tool.

### D10 — `idempotencyKey`, an optional string argument

Present on every tool whose operation is `idempotent: true` (12 of the 19 — every exposed write). Passed through
as the `Idempotency-Key` header, so validation (`idempotencyKeySchema`), replay, the
`Idempotent-Replayed` marker and `idempotency_in_progress` for an in-flight duplicate are
whatever `handle.ts` and `runIdempotent` already do (FR-025). Omitting it behaves as an HTTP
call without the header.

**Rejected**: generating one per call (a model retrying would get a new key and a second
effect — worse than no idempotency, and it would invent behaviour the HTTP API does not
have); requiring it (the HTTP API does not).

### D11 — The tests reuse the existing per-operation fixture table

`FIXTURES` and its `fill`/`call` helpers move from
`tests/integration/api/scope-enforcement.test.ts` into `tests/helpers/api-fixtures.ts`,
unchanged, and the scope test imports them. The MCP suite then derives each tool's arguments
from the *same* fixture by flattening it (`{...params, ...body}` plus the fixture's query),
which is what makes the equivalence test (SC-009) honest: both front doors are driven from
one description of a valid call.

**Rejected**: a second fixture table for MCP (two lists to keep in step — the defect this
entry is about); generating arguments from the Zod schemas (no generator exists, and
`z.toJSONSchema` does not produce instances).

### D12 — Layout and the import boundary

```text
src/server/mcp/
  dispositions.ts   # the exposed/withheld surface derived from OPERATIONS; no protocol, no IO
  naming.ts         # operation id -> tool name, and the frozen published list
  schema.ts         # the flat Zod schema per tool and the inlined JSON Schema
  describe.ts       # the four-part description generator
  bridge.ts         # tool call -> Request -> handleApiRequest -> tool result
  protocol.ts       # the only file importing @modelcontextprotocol/sdk  (NEEDS DEPENDENCY)
src/app/api/mcp/route.ts
```

`src/server/mcp/**` is added to `tests/lint/api-imports.test.ts`'s `pipeline` list (no
database client) and `src/app/api/mcp/**` to the `strict` list (no DAL for data access).
`bridge.ts` imports `handleApiRequest` and nothing from the DAL, so the boundary holds
without an exception.

**Rejected**: putting it under `src/server/api/mcp/` (the lint lists are path-prefixed and
`src/server/api/operations/**` is checked more strictly than a bridge needs; more
importantly MCP is a *caller* of the API pipeline, not part of it); a single `mcp.ts` (the
protocol-dependent part could not then be isolated from the parts that build and test
without the package).

### D13 — Tool names are frozen in a committed list

`docket_` + the operation id in snake_case. The derivation is a pure function; the
nineteen names it produces today are committed to `src/server/mcp/naming.ts` as
`PUBLISHED_TOOL_NAMES` and asserted by test (FR-004), so renaming an operation id breaks
the build rather than a client's saved instructions. Adding an exposed operation adds a name
to that list — the one edit outside the operation definition that the spec's "no second
file" rule tolerates, because a *new* name cannot break an existing client and the test
message says exactly what to add.

**Rejected**: no frozen list (FR-004 requires one); a name independent of the operation id
(FR-004 requires the derivation).

### D14 — The error shape travels unchanged

The tool result for a failure is `isError: true` with the API's error body
(`{ error: { code, message, details?, requestId } }`) serialised as text, plus the wait in
seconds when the code is `rate_limited`. No stack trace, no key, no other project's
identifiers — because the body is the one `errorBody()` already produces for HTTP, and the
secret scan covers it (FR-028, FR-029).

### D15 — Recorded gaps, not filled here

- **No `listPosts`.** A model can fetch a post by id and can learn ids from
  `createPost`, `generatePost` and `listActivity`, but cannot browse the project's posts.
  Belongs in a later API entry (FR-027); noted in the documentation's withheld/gaps section.
- **No media upload or import over MCP.** `uploadMedia` is multipart;
  `registerMediaFromUrl` would make the server fetch an arbitrary URL on a model's say-so.
  Media *reads* are exposed so a model can choose an existing image.
- **`manage_jobs` reaches nothing over MCP.** All nine job operations are withheld, so a
  key holding only `manage_jobs` lists tools and can call none of them. The documentation
  says so rather than hiding it.

### D16 — A tool call costs one request, not two

`forApiKey` increments the key's rate-limit window on every call
(`countRequest`, `src/server/dal/api-keys.ts:185`). Resolving the key in the MCP layer *and*
in `handleApiRequest` would therefore charge a tool call twice and halve the key's effective
limit over MCP — a divergence FR-015 ("the same bucket") would not survive review.

So `initialize` and `tools/list` resolve the key (one request, one count, and `tools/list`
needs the project name anyway), and a `tools/call` does not: it checks that a credential is
present and well formed without touching the database, runs the static argument and
`confirm` checks, and lets the pipeline perform the single counting resolution. The ordered
consequence and why it is acceptable are in
[contracts/mcp-transport.md §9](./contracts/mcp-transport.md).

**Rejected**: resolving twice (halves the limit); adding a non-counting key resolver to the
DAL (new DAL surface, and a second way to authenticate a key is exactly the kind of
duplication constitution IV and FR-011 are about); skipping MCP-layer authentication
altogether (FR-009 requires an absent or malformed key to be refused `invalid_api_key` on a
tool call as well as a listing).

## Open risks for the implement phase

1. **`NEEDS DEPENDENCY: @modelcontextprotocol/sdk`** blocks `protocol.ts`, the route and
   every test that goes through the protocol. The surface, the schemas, the descriptions,
   the bridge and their tests do not depend on it and are built first.
2. **The `[confirm]` items in `docs/research/mcp.md`** must be read from the installed
   package's types before `protocol.ts` is written, and that file updated with what was
   found.
3. **`errorStatuses` moving out of `openapi.ts`** must not change the document;
   `tests/integration/api/openapi.test.ts` is the guard and runs unchanged.
4. **`docs/n8n.md` headings are numbered** and `src/lib/docs.ts` links into docs pages by
   anchor, so the cross-reference is added as a new trailing section plus a line in the
   intro — no existing heading is renumbered.
5. **The conditional confirmation on `docket_generate_post` (D9) deviates from the spec's
   Decisions text** and is the one judgement in this plan a reviewer should accept or
   reverse deliberately.
