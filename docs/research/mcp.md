# Model Context Protocol (MCP)

Verified facts for Docket's MCP front door (spec `074-mcp-server`). Sources are the
official specification site, `modelcontextprotocol.io`.

## Status of this document (read first)

The spec-kit phases that wrote this file could not fetch page bodies — only search
results from the official site. Every statement below carries the official URL it came
from, and each is labelled:

- **[spec]** — stated by the official specification page cited.
- **[confirm]** — needed before the protocol file is written, and **must be read out of
  the installed SDK's own types in `node_modules/@modelcontextprotocol/sdk`**
  (constitution I allows an installed package's own docs/types as a source).

`@modelcontextprotocol/sdk` is **not installed** (`package.json`, checked 2026-10-14):
every task that touches the wire format is marked `NEEDS DEPENDENCY` in
`specs/074-mcp-server/tasks.md`. Nothing else in the entry depends on it.

The point of the design in `specs/074-mcp-server/plan.md` is that all of the **[confirm]**
items land in exactly one file (`src/server/mcp/protocol.ts`). The tool surface, the
descriptions, the confirmation and idempotency arguments, the pipeline bridge and all of
the tests are protocol-independent and are built and run without the SDK.

## 1. Revisions

MCP is versioned by dated revision, not semver. Revisions published as of 2026-10:
`2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`, plus `draft`. **[spec]**
<https://modelcontextprotocol.io/specification/2026-07-28/changelog>
<https://modelcontextprotocol.io/specification/draft/basic/versioning>

Which revision to implement, and the exact version string to negotiate, is **[confirm]**:
take the revision the installed SDK implements rather than the newest published one.

## 2. Transport: Streamable HTTP

- Streamable HTTP arrived in `2025-03-26` and replaced the `2024-11-05` HTTP+SSE
  transport. **[spec]**
  <https://modelcontextprotocol.io/specification/2025-03-26/basic/transports>
- The server exposes a **single HTTP endpoint** (the "MCP endpoint") that accepts POST.
  The client sends each JSON-RPC request or notification as its own POST. **[spec]**
- The server answers a POST with **either** `Content-Type: application/json` (one JSON
  object) **or** `Content-Type: text/event-stream` (an SSE stream scoped to that
  request). A server that only answers requests may always use the single JSON
  object. **[spec]**
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- The client MUST send an `Accept` header listing `text/event-stream` as supported. A
  server that never streams still receives that header; it does not have to use it. **[spec]**
- If an `Origin` header is present and invalid, the server MUST answer **403**. **[spec]**
- A GET or DELETE to the MCP endpoint may be answered **405**; the specification's
  backward-compatibility section expects clients to cope with 405 there. **[spec]**
- Revision `2026-07-28` requires every POST to carry an `MCP-Protocol-Version` header
  whose value matches the `io.modelcontextprotocol/protocolVersion` field in the request
  body's `_meta`; a mismatch MUST be rejected **400** with a `HeaderMismatch` JSON-RPC
  error. **[spec]**
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
  <https://modelcontextprotocol.io/seps/2243-http-standardization>
- **[confirm]**: the session-id header and whether a stateless server may omit it; the
  exact JSON-RPC error code for `HeaderMismatch`; the `initialize` request and response
  fields and the capability negotiation shape; whether the SDK's server transport can be
  driven from a WHATWG `Request`/`Response` pair (Next.js route handlers get those, not
  Node `req`/`res`).

## 3. Tools

- Clients discover tools with a `tools/list` request and invoke them with
  `tools/call`. **[spec]**
  <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- A tool definition carries `name`, `title`, `description`, `inputSchema` (a JSON Schema
  object whose `type` is `"object"`, with optional `properties` and `required`),
  optional `outputSchema`, and optional `annotations`. **[spec]**
- Display-name precedence for a tool is `title`, then `annotations.title`, then
  `name`. **[spec]**
- A `tools/call` result (`CallToolResult`) carries `content` (an array of content
  blocks), optional `structuredContent`, optional `isError`, and `_meta`. `isError`
  defaults to false. **[spec]**
- **Tool execution failures are reported inside the result with `isError: true`**, not as
  JSON-RPC protocol errors, so the model can see the failure and correct itself.
  Protocol-level errors are reserved for conditions like an unknown tool name. **[spec]**
  <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- **[confirm]**: the content-block shape for text (field names), whether `inputSchema`
  may contain `$defs`/`$ref` (Docket inlines them regardless — see the plan), and the
  JSON Schema dialect clients assume.

## 4. Authorization

- Authorization is **optional** for an MCP implementation; implementations that use an
  HTTP transport **SHOULD** conform to the authorization specification, which is built on
  OAuth 2.1, RFC 6750 and RFC 8414. A protected server acts as an OAuth 2.1 resource
  server. **[spec]**
  <https://modelcontextprotocol.io/specification/draft/basic/authorization>
- Clients MUST send the credential in the `Authorization: Bearer <token>` request header,
  on **every** HTTP request, and MUST NOT put it in the URI query string. **[spec]**
- Servers MUST validate the token's audience (RFC 8707 §2) and MUST answer **401** for an
  invalid or expired token. **[spec]**
- The specification also says a client MUST NOT send a server any token other than one
  issued by that server's authorization server, and a server MUST only accept tokens
  valid for its own resources. **[spec]**

**What this means for Docket**: Docket does **not** implement the OAuth 2.1 profile. It
accepts its own project-scoped API key as the bearer credential, which is Docket's own
credential for Docket's own resource — consistent with the audience rule, and permitted
because authorization is optional and the profile is a SHOULD. A client that wants OAuth
discovery finds no `WWW-Authenticate` challenge pointing at an authorization server and no
protected-resource metadata; it must be configured with a static header instead, exactly as
`docs/n8n.md` configures n8n. The accepted cost is recorded in `docs/decisions.md` (074).

## 5. Why this is thin on purpose

Docket's MCP layer translates a tool call into the inputs `src/server/api/handle.ts`
already takes and translates the answer back (`specs/074-mcp-server/plan.md`). Everything
above that is wire format, and every **[confirm]** item lives in the one file that speaks
it. If a later revision changes the handshake or the headers, that file changes and the
nineteen tools do not.
