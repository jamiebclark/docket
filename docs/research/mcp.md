# Model Context Protocol (MCP)

Verified facts for Docket's MCP front door (spec `074-mcp-server`). Sources are the
official specification site, `modelcontextprotocol.io`, and the installed SDK.

## Status of this document (read first)

This file was written in two passes, and the second one changed the central conclusion.

- **Pass 1 (spec-kit `plan` phase)** could not fetch page bodies — only search results
  from the official site — so it labelled the wire-format details it could not confirm.
- **Pass 2 (operator, 2026-10-14)** fetched the specification pages directly and then
  installed `@modelcontextprotocol/sdk` and read its types. Items it settled are marked
  **[verified]** with how they were established.

Labels used below:

- **[spec]** — stated by the official specification page cited.
- **[verified]** — read from a fetched specification page, or out of the installed
  package's own types (constitution I allows an installed package's own docs/types).
- **[confirm]** — still open; must be closed from the installed SDK before
  `src/server/mcp/protocol.ts` is written.

`@modelcontextprotocol/sdk@1.32.1` **is now installed** (added 2026-10-14; it was absent
when the plan was written, and the `NEEDS DEPENDENCY` markers in
`specs/074-mcp-server/tasks.md` are satisfied by that install).

The design in `specs/074-mcp-server/plan.md` confines every protocol-dependent fact to one
file (`src/server/mcp/protocol.ts`). That containment is what makes the revision question
below survivable: the tool surface, the descriptions, the confirmation and idempotency
arguments, the pipeline bridge and all of the tests are protocol-independent.

## 1. Revisions — and why Docket targets an older one deliberately

MCP is versioned by dated revision, not semver; the date names the last
backwards-incompatible change. Published revisions as of 2026-10: `2024-11-05`,
`2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`, plus `draft`. **[spec]**
<https://modelcontextprotocol.io/specification/versioning>

**The current published revision is `2026-07-28`. [verified]** (fetched)

**The installed SDK's ceiling is `2025-11-25`. [verified]** — read from
`node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`:

```js
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
```

So the official TypeScript SDK does not implement the current published revision. **Docket
therefore implements `2025-11-25`, the newest revision the SDK speaks** — which is the rule
the plan already set ("take the revision the installed SDK implements rather than the newest
published one") and the right one: constitution VI forbids hand-rolling a substitute for a
library, and targeting `2026-07-28` would mean writing from scratch the parts the SDK has
not caught up to.

This is a deliberate, recorded lag, not an oversight. It matters because `2026-07-28` is not
a routine increment — it removes things the handshake era requires. **§6 lists what changes**
so whoever upgrades knows what breaks. Until then, the handshake-era shape is correct:
`initialize` exists, sessions exist, and a result carries no `resultType`.

## 2. Transport: Streamable HTTP

Facts below are for the era Docket implements (`2025-11-25`), which shares its transport
shape with `2025-03-26`+.

- Streamable HTTP arrived in `2025-03-26` and replaced the `2024-11-05` HTTP+SSE
  transport, which is deprecated and **SHOULD NOT** be adopted by new
  implementations. **[spec]**
- The server exposes a **single HTTP endpoint** (the "MCP endpoint") accepting POST. The
  client sends each JSON-RPC request or notification as its own POST. **[spec]**
- The server answers a POST with **either** `Content-Type: application/json` (one JSON
  object) **or** `Content-Type: text/event-stream` (an SSE stream scoped to that request).
  A server that only answers requests may always use the single JSON object. **[spec]**
- The client **MUST** send an `Accept` header listing both `application/json` and
  `text/event-stream`. A server that never streams still receives that header and does not
  have to use it. **[verified]** (fetched)
- If an `Origin` header is present and invalid, the server **MUST** answer
  **403**. **[verified]** (fetched). When running locally, bind to `127.0.0.1` rather than
  `0.0.0.0`. **[spec]**
- Servers **SHOULD** send `X-Accel-Buffering: no` on an SSE response so reverse proxies do
  not buffer it. **[verified]** (fetched) — only relevant if streaming is ever enabled.
- A notification POST the server accepts gets **`202 Accepted` with no
  body**. **[verified]** (fetched)
- In this era the server **MAY** assign a session via the `Mcp-Session-Id` header
  (terminated by HTTP DELETE), a client **MAY** open a standalone SSE stream with GET, and
  streams are resumable via `Last-Event-ID`. **Docket uses none of these** — see the
  stateless-mode note below. **[verified]** (fetched, from the `2026-07-28` page's account
  of what earlier revisions did)
- `MCP-Protocol-Version` on every POST was introduced in `2025-06-18`; in `2026-07-28` it
  must match the body's `_meta` or be rejected `400` with JSON-RPC error **`-32020`
  (`HeaderMismatch`)**. **[verified]** (fetched) — this resolves the plan's open question
  about that error code, though the strict header/body matching rule belongs to the
  revision Docket is not yet implementing.

### The SDK's web-standard transport — this was the plan's main open question

The plan asked whether the SDK's server transport can be driven from a WHATWG
`Request`/`Response` pair, since Next.js route handlers get those rather than Node
`req`/`res`. **It can. [verified]** — `node_modules/@modelcontextprotocol/sdk/dist/esm/server/`
ships two transports:

| Export | Signature | Use |
|---|---|---|
| `StreamableHTTPServerTransport` | `handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?)` | Node/Express; wraps the one below |
| `WebStandardStreamableHTTPServerTransport` | `handleRequest(req: Request, options?): Promise<Response>` | **this one** — "any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun" |

The web-standard transport is the SDK's own core implementation, with the Node one layered
over it, so using it is the direct path and not a workaround. Two options settle Docket's
shape:

- **`sessionIdGenerator`** is optional: "If not provided, session management is disabled
  (stateless mode)." Omitting it is how Docket gets no sessions — which is both what the
  key-decides-the-project design wants and what `2026-07-28` will later mandate.
- **`enableJsonResponse`** makes the transport answer a single JSON object rather than an
  SSE stream.

An `EventStore` interface exists for resumability; Docket needs none, since nothing it
exposes is long-running enough to resume.

**[confirm]** remaining: the exact `McpServer`/`Server` registration API for tools and
whether tool input schemas are registered as Zod or as JSON Schema (the package ships
`zod-compat.js` and `zod-json-schema-compat.js`, which suggests both are accommodated —
read them before writing `protocol.ts`).

## 3. Tools

- Clients discover tools with `tools/list` and invoke them with `tools/call`. **[spec]**
- A tool definition carries `name`, `title`, `description`, `inputSchema` (a JSON Schema
  object of `type: "object"`, with optional `properties` and `required`), optional
  `outputSchema`, and optional `annotations`. `2026-07-28` adds optional `icons`.
  `inputSchema` **MUST** be a valid JSON Schema object and never `null`; for a tool with no
  parameters, `{"type": "object", "additionalProperties": false}` is the recommended
  shape. **[verified]** (fetched)
- Display-name precedence is `title`, then `annotations.title`, then `name`. **[spec]**
- A `tools/call` result (`CallToolResult`) carries `content` (an array of content blocks),
  optional `structuredContent`, optional `isError` (default false), and `_meta`. **[spec]**
  A text content block is `{"type": "text", "text": "..."}`; the other block types are
  `image`, `audio`, `resource_link` and `resource`. **[verified]** (fetched) — this closes
  the plan's open question about the text block's field names.
- **Tool execution failures are reported inside the result with `isError: true`**, not as
  JSON-RPC protocol errors, so the model can see the failure and correct itself. Protocol
  errors are reserved for an unknown tool, a malformed request, or a server error. The
  spec's own test is whether the model can plausibly fix it by trying again differently;
  clients **SHOULD** pass execution errors to the model and **MAY** pass protocol
  errors. **[verified]** (fetched)
- **Tool names** are SHOULD-level: 1–128 characters, case-sensitive, only ASCII letters,
  digits, underscore, hyphen and dot, unique within the server. `docket_create_post`
  satisfies all of them. The spec separately notes that clients aggregating several servers
  may hit name collisions and **SHOULD** prefix to disambiguate, and that `serverInfo.name`
  is **not** a reliable disambiguator — an independent argument for the `docket_`
  prefix. **[verified]** (fetched)
- The capability declaration is `{"capabilities": {"tools": {"listChanged": true}}}`;
  `listChanged` says whether the server emits `notifications/tools/list_changed`. Docket's
  tool list does not change at runtime, so it has no reason to declare
  it. **[verified]** (fetched)

Two rules that bear directly on this entry, both **[verified]** (fetched from the
`2026-07-28` tools page, which states them explicitly):

> This set … **MUST NOT** vary per-connection or as a side effect of other requests on the
> connection. The set **MAY** vary by the authorization presented on the request … since
> credentials are per-request input, not connection state.

So varying the tool list by the presented key's permissions is **explicitly sanctioned**,
and requiring authentication to list at all is consistent with it. Servers **SHOULD** also
return tools in a deterministic order, because clients cache the list and a stable order
improves prompt-cache hit rates — which is a reason to derive the list from an ordered
table rather than from object-key iteration.

There is also no protocol-level session in any revision's tool model: "a server cannot rely
on implicit per-connection state to relate one tool call to the next", and the spec's
guidance is to pass explicit handles as arguments. Docket needs none — the key pins the
project and every id a tool returns is already a durable database id. Worth recording
because it makes "the key decides the project" the only workable answer rather than merely
the tidiest. **[verified]** (fetched)

## 4. Authorization

- Authorization is **OPTIONAL** for an MCP implementation. When supported: implementations
  using an **HTTP-based transport SHOULD** conform to the authorization specification, which
  is an OAuth 2.1 profile; implementations using a **STDIO transport SHOULD NOT** follow it
  and should "instead retrieve credentials from the
  environment". **[verified]** (fetched)
- Within that profile: a protected server acts as an OAuth 2.1 resource server and **MUST**
  implement RFC 9728 Protected Resource Metadata; clients **MUST** send the credential as
  `Authorization: Bearer <token>` on **every** request and **MUST NOT** put it in the URI
  query string; servers **MUST** validate the token's audience (RFC 8707 §2) and **MUST**
  answer **401** for an invalid or expired token, with a `WWW-Authenticate: Bearer` challenge
  carrying `resource_metadata` and `scope`. Insufficient scope is **403** with
  `error="insufficient_scope"`. **[verified]** (fetched)
- The spec's security section for the HTTP transport says servers **SHOULD** implement proper
  authentication for all connections — so "no auth" is not an option. **[verified]** (fetched)

**What this means for Docket.** Docket does **not** implement the OAuth 2.1 profile. It
accepts its own project-scoped API key as the bearer credential — Docket's own credential
for Docket's own resource, consistent with the audience rule, and permitted because
authorization is optional and the profile is a SHOULD rather than a MUST. A client wanting
OAuth discovery finds no `WWW-Authenticate` challenge pointing at an authorization server
and no protected-resource metadata; it must be configured with a static header instead,
exactly as `docs/n8n.md` configures n8n. The header shape is identical to the profile's, so
a client that simply sends a configured token works. The accepted cost is recorded in
`docs/decisions.md` (074).

**The alternative that was available, for the record.** The spec points STDIO servers at
"credentials from the environment", which fits a static API key better than the HTTP
profile does — a thin stdio server reading `DOCKET_API_KEY` would be the spec-sanctioned
home for exactly the credential Docket has. It was not chosen because it contradicts two
decisions this entry rests on: hosting the server as a route in the Next app rather than a
separate process, and running every tool call through `handle.ts` in-process rather than
over the network. Worth revisiting only if a client appears that cannot be configured with
a static header.

## 5. Why this is thin on purpose

Docket's MCP layer translates a tool call into the inputs `src/server/api/handle.ts`
already takes and translates the answer back (`specs/074-mcp-server/plan.md`). Everything
above that is wire format, and every protocol-dependent item lives in the one file that
speaks it. If a later revision changes the handshake or the headers, that file changes and
the nineteen tools do not.

## 6. What changes at `2026-07-28`, for whoever upgrades

Recorded now, while it is in hand, because the SDK will eventually catch up and the
differences are structural rather than cosmetic. All **[verified]** (fetched).

| | `2025-11-25` (what Docket implements) | `2026-07-28` (current published) |
|---|---|---|
| Handshake | `initialize` request/response | **none** — every request carries its version in `_meta`; `server/discover` is a mandatory RPC for clients that want to ask up front |
| Version negotiation | once, at `initialize` | **per request**, accepted or rejected independently |
| Sessions | `Mcp-Session-Id`, `DELETE` to end | **removed** |
| Standalone SSE stream | `GET` on the endpoint | **removed** — `GET`/`DELETE` answer `405`; ignore `Mcp-Session-Id` and `Last-Event-ID` |
| Server→client requests | sent on an SSE stream | **removed** — embedded in results as `InputRequiredResult` (MRTR) |
| Stream resumption | `Last-Event-ID` | **not supported** |
| Result envelope | `{content, isError}` | adds a required **`resultType`** (`"complete"` \| `"input_required"`) |
| Required headers | `MCP-Protocol-Version` | adds `Mcp-Method` and `Mcp-Name`, with strict header↔body matching enforced as `400` / `-32020` |
| Required `_meta` | — | `io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities` |
| `listChanged` delivery | notification | only to clients that opened a `subscriptions/listen` stream with `toolsListChanged: true` |
| Unknown method | JSON-RPC error | `404` + `-32601` |
| Unsupported version | — | `400` + `UnsupportedProtocolVersionError` listing supported versions |

Docket's stateless, JSON-only, no-GET shape is already the direction `2026-07-28` went, so
the upgrade is mostly deletions plus the `resultType` field and the header rules.

## What this file does not cover

Resources, prompts, sampling, elicitation, roots, completion, logging, and pagination beyond
the cursor field; `server/discover`'s exact shape; the MRTR `InputRequiredResult` flow beyond
noting it replaces server-initiated requests; `x-mcp-header` (an optional server feature
Docket has no reason to use, and whose own spec warns against mirroring sensitive values);
and the OAuth 2.1 flow in detail (client registration, PKCE, the `resource` parameter,
step-up authorization). Each was read only far enough to establish the facts above, because
this entry exposes tools only and authenticates with a key. Re-read the authorization pages
in full before any later entry adds an OAuth path.
