# Implementation Plan: An MCP server over the v1 API

**Branch**: `074-mcp-server` | **Date**: 2026-10-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/074-mcp-server/spec.md`

## Summary

Expose Docket to LLM clients as a second front door onto the operations the v1 API already
has. One route, `POST /api/mcp`, speaks MCP; nineteen tools are derived from the 34-entry
operation table in `src/server/api/operations/`; each tool call is turned into the `Request`
that `handleApiRequest` already takes, and the answer is turned back. Nothing about
authentication, rate limiting, permissions, input parsing, idempotency or error mapping is
written twice.

Four things make that work:

1. **`ApiOperation` gains a required `mcp` field** — exposed, exposed-with-confirmation, or
   withheld with a reason. Required, so an operation cannot compile without a decision, and
   the decision is made in the same edit that adds the operation. A drift test re-asserts
   the rule at run time and checks the derived surface against the table both ways.
2. **Everything about a tool is a function of its operation**: the name (`docket_` +
   snake_case id, frozen in a committed list), the input schema (`z.toJSONSchema` over the
   operation's own `params`/`query`/`body`, inlined), the description (the operation's
   summary plus four generated parts), the required permission.
3. **One bridge, no second pipeline.** `callTool` fills the operation's path, builds the
   query string and the JSON body, copies the credential headers, adds `Idempotency-Key`
   when the caller passed one, and calls `handleApiRequest`. The equivalence the spec asks
   for is structural rather than tested into existence.
4. **The tests reuse what exists.** The per-operation fixture table moves out of
   `tests/integration/api/scope-enforcement.test.ts` into a helper, so one description of a
   valid call drives both front doors.

**What is blocked and what is not.** The wire format needs `@modelcontextprotocol/sdk`,
which is not installed (`NEEDS DEPENDENCY`), and the handshake details are not yet
verifiable: `docs/research/mcp.md` records what the official specification states and marks
the rest for reading out of the installed package's own types. Those facts are confined to
one file, `src/server/mcp/protocol.ts`. The disposition field, the derivation, the naming,
the schemas, the descriptions, the confirmation and idempotency arguments, the bridge and
every test above the protocol can be built and run today.

**No database change**: no table, no column, no enum value, no migration, no new permission.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, pnpm

**Primary Dependencies**: Next.js 16 App Router (standalone), Zod 4.6.5 — `z.toJSONSchema`
supplies the tool input schemas, verified present, so no package is needed for JSON Schema —
Drizzle ORM, Vitest. **One new runtime dependency, `@modelcontextprotocol/sdk`
(`NEEDS DEPENDENCY`)**, justified under Complexity Tracking.

**Storage**: Postgres, unchanged. The only rows a tool call writes are the ones the
equivalent HTTP request writes, including the idempotency record.

**Testing**: Vitest. Unit tests for the protocol-free modules (`src/server/mcp/*` except
`protocol.ts`); integration tests against a real Postgres (locally port **5555**, see
`docs/getting-started.md`) driving the MCP layer in-process, exactly as
`tests/helpers/api.ts` drives the v1 route module — no listening server.

**Target Platform**: Linux server (Docker Compose: web, worker, postgres) and Neon. The MCP
route runs in the existing web container: no new process, no new port.

**Project Type**: Web service. One Next.js app; the public API is a catch-all route over an
operation table, and MCP becomes a second route over the same table.

**Performance Goals**: one tool call is one `Request`, one JSON round trip and exactly one
service call — the work the HTTP request already does plus one serialise/parse. The tool
list is built once per process at module load. A tool call costs **one** unit of the key's
rate limit, not two (research D16).

**Constraints**: the MCP layer reaches data only through `handleApiRequest` (constitution
III and IV, enforced by extending `tests/lint/api-imports.test.ts`); no v1 operation,
request shape or response shape changes (FR-027); no new error code
(`confirmation_required` is already in `API_ERROR_CODES`); no capability the API lacks.

**Scale/Scope**: one new required field on 34 operations, 19 derived tools (5 of them
confirmed), 15 published withholdings, 1 new route, 6 new source files, 1 extracted module,
1 extracted test helper, ~5 test files, 4 documentation files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| I. Verified facts over memory | Protocol facts were not in the repo, so `docs/research/mcp.md` was written for this entry, citing `modelcontextprotocol.io` for the transport, the tool definition, the result shape and the authorization convention. The phases cannot fetch page bodies, so each statement is labelled **[spec]** (cited) or **[confirm]** (must be read from `node_modules/@modelcontextprotocol/sdk`, which constitution I allows). Every *repository* fact this plan stands on is cited by path in `research.md`, and `z.toJSONSchema`'s behaviour was measured, not assumed. | **PASS with a named residual**: `protocol.ts` must not be written until the **[confirm]** list is closed from the installed package's types. Nothing else depends on it. |
| II. Nothing is "working" unless it ran | Every tool is exercised against a real Postgres through the real pipeline and compared with the same call over HTTP. Nothing here needs a third-party credential, so nothing is "verified with mocks only". The one manual step — a real MCP client against the route — is in `quickstart.md`. | PASS |
| III. Project isolation enforced in one place | The MCP layer builds no `ProjectScope` and reaches no repository: a tool call goes through `handleApiRequest`, which resolves the key's scope exactly as it does for HTTP. No tool accepts a project identifier. `src/server/mcp/**` joins the import-boundary test, and the cross-project test runs for every tool taking a resource id, using project B's rows. | PASS |
| IV. One service layer, many callers | MCP becomes a fourth caller of the same operations and therefore of the same services. No service function changes. `errorStatuses`/`codesFor` move to a shared module so one derivation serves both the OpenAPI document and the tool descriptions instead of being copied. | PASS |
| V. Providers are plug-ins | No provider, scheduler, composer or schema change. The three ambiguous-publish recovery operations are withheld, which is constitution V's "never retried automatically" carried into the new surface. | PASS |
| VI. Boring, few dependencies | **One new runtime dependency**; no new infrastructure, because the server is a route in the existing web container. See Complexity Tracking. | **PASS with a justified exception** |
| VII. Secrets never leak | No credential is stored, logged or echoed: the key is read from the request headers and copied into the request the bridge builds, and nothing writes it anywhere. A tool description carries the project's name and nothing else about it. Error bodies are the ones `errorBody()` already produces. The secret scan is extended with a listing, a call, and both with a tampered key. | PASS |

**Engineering constraints**: no scheduler work (`runTick()` untouched); no Temporal
arithmetic (times pass through as the operations' own strings); no UI change, since the only
browser step — creating a key — already exists; `mkdocs.yml` has `strict: true`, so the new
page must join the nav in the same commit.

**Re-check after Phase 1 design**: PASS — see "Post-design constitution re-check" below.

## Project Structure

### Documentation (this feature)

```text
specs/074-mcp-server/
├── plan.md               # This file
├── research.md           # Phase 0: D1–D16, each with its code citations
├── data-model.md         # Phase 1: the disposition field, the 34-row table, the derived tool
├── quickstart.md         # Phase 1: how to run and prove it
├── contracts/
│   ├── mcp-tools.md      # The tool surface: names, arguments, results, confirmations
│   └── mcp-transport.md  # The route, the module seams, the function signatures
└── tasks.md              # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

Also written by this phase, because the protocol facts belong in the repository rather than
in a spec folder: `docs/research/mcp.md`.

### Source Code (repository root)

```text
src/
├── app/
│   └── api/mcp/route.ts                    # new: POST (the endpoint), GET/DELETE (405)
└── server/
    ├── api/
    │   ├── error-surface.ts                # new: errorStatuses + codesForStatus, extracted
    │   ├── openapi.ts                      # imports them; document output unchanged
    │   ├── handle.ts                        # unchanged — the bridge calls it as-is
    │   └── operations/
    │       ├── types.ts                    # + required `mcp: McpDisposition`
    │       ├── accounts.ts … voice.ts      # + one `mcp` field per operation (34)
    │       └── openapi.ts                  # withheld: permission is null
    └── mcp/
        ├── dispositions.ts                 # EXPOSED / WITHHELD / dispositionProblems
        ├── naming.ts                       # toolNameFor + PUBLISHED_TOOL_NAMES
        ├── schema.ts                       # flat Zod schema + inlined JSON Schema
        ├── describe.ts                     # the four-part description generator
        ├── bridge.ts                       # tool call -> Request -> handleApiRequest
        └── protocol.ts                     # the only SDK importer   (NEEDS DEPENDENCY)

tests/
├── helpers/
│   ├── api-fixtures.ts                     # new: FIXTURES + fill/call, moved out of the scope test
│   └── mcp.ts                              # new: drives the MCP route in-process, like api()
├── lint/api-imports.test.ts                # + src/server/mcp and src/app/api/mcp
├── unit/mcp/
│   ├── naming.test.ts
│   ├── schema.test.ts
│   └── describe.test.ts
└── integration/
    ├── api/
    │   ├── scope-enforcement.test.ts       # imports the moved fixtures; assertions unchanged
    │   ├── openapi.test.ts                 # unchanged: the proof the extraction was neutral
    │   ├── mcp-surface.test.ts             # new: the drift test (FR-003, FR-004, FR-005, FR-007)
    │   └── mcp-tools.test.ts               # new: auth, permissions, isolation, confirm, idempotency, equivalence
    └── security/secret-scan.test.ts        # + the MCP route calls

docs/
├── mcp.md                                  # new: the operator guide, beside n8n.md
├── n8n.md                                  # + a cross-reference (new trailing section; no heading renumbered)
├── security.md                             # + same keys, same permissions, no new trust boundary
├── decisions.md                            # + the 074 entry
├── research/mcp.md                         # new (written by this phase)
└── ../mkdocs.yml                           # + the nav entry (strict: true)
```

**Structure Decision**: a new `src/server/mcp/` sibling to `src/server/api/`, because MCP is
a *caller* of the API pipeline rather than part of it, and because the protocol-dependent
file has to be isolable from the five that are not. The route lives at `src/app/api/mcp/`,
not under `/api/v1`, so MCP never appears in the v1 router or the OpenAPI document.

## Phase 0 — Outline & Research

Output: [research.md](./research.md) and [`docs/research/mcp.md`](../../docs/research/mcp.md).

Unknowns taken from the spec and what became of them:

| Unknown | Outcome |
|---|---|
| `NEEDS RESEARCH: docs/research/mcp.md` (constraint 1) | **Partly resolved.** The transport, the tool definition, the result/`isError` convention and the authorization convention are written up with official citations. The handshake fields, the JSON-RPC error codes, the content-block shape and the SDK's own API remain open and are labelled **[confirm]** — to be read from the installed package's types, which constitution I permits. |
| `NEEDS DEPENDENCY: @modelcontextprotocol/sdk` (constraint 2) | **Unresolved by design.** Confirmed absent from `package.json` and `node_modules`. Only `protocol.ts`, the route and the protocol-level tests depend on it. |
| How the surface is both derived and deliberately scoped (constraint 3) | A required field on the operation (D1). |
| Where the idempotency key goes (constraint 7) | An optional argument the bridge turns back into the header (D10). |
| Whether JSON Schema needs a new package | No: `z.toJSONSchema` is in the installed Zod, and its behaviour on operation-shaped schemas was measured (D7). |
| How MCP authorization relates to Docket's API keys | MCP's authorization profile is OAuth 2.1 and is optional; Docket accepts its own key as the bearer credential and publishes no OAuth metadata. Recorded with its cost in `docs/research/mcp.md` §4 and in the 074 decisions entry. |

The one open judgement a reviewer should rule on deliberately: **the conditional
confirmation on `docket_generate_post`** (research D9). The spec's Decisions say generation
is exposed without confirmation, but `generatePost` accepts
`schedulingPolicy: "add_to_queue"`, which publishes to live accounts in the same call.
FR-020 and FR-021 are MUSTs about effects, so the plan gates *that argument combination*
and leaves plain generation unconfirmed. Reversing it is one line in that operation's
disposition.

## Phase 1 — Design & Contracts

Outputs: [data-model.md](./data-model.md),
[contracts/mcp-tools.md](./contracts/mcp-tools.md),
[contracts/mcp-transport.md](./contracts/mcp-transport.md),
[quickstart.md](./quickstart.md).

### Build order (and why it survives the blocked dependency)

1. **`mcp` on `ApiOperation`, and a disposition on all 34 operations.** Breaks nothing at
   run time and makes `pnpm typecheck` the first gate. Touches the eleven operation files
   and the five test files that build a throwaway operation with `defineOperation`
   (`errors`, `idempotency`, `idempotency-generate`, `openapi`, `pipeline` under
   `tests/integration/api/`), each of which gets
   `mcp: { expose: false, reason: "test-only operation" }`. Three of those files push their
   operation into `OPERATIONS` in `beforeAll` and splice it out in `afterAll`, so the
   derived surface must be read from `OPERATIONS` on first use rather than captured at
   import time by a module those tests also load.
2. **`error-surface.ts`**, with `openapi.ts` rewired to it. Proof of neutrality:
   `tests/integration/api/openapi.test.ts` passes unedited.
3. **`dispositions.ts`, `naming.ts`, `schema.ts`, `describe.ts`** and their unit tests, plus
   `mcp-surface.test.ts`. This is the whole of FR-001 to FR-007 and SC-002/SC-006/SC-008,
   and none of it needs the SDK.
4. **`tests/helpers/api-fixtures.ts`**, extracted; `scope-enforcement.test.ts` imports it
   with no assertion changed.
5. **`bridge.ts`** and `mcp-tools.test.ts` driven through the bridge directly — FR-011 to
   FR-018, FR-020, FR-025, SC-003/SC-005/SC-009 are all provable without a protocol byte.
6. **`protocol.ts` and the route** — `NEEDS DEPENDENCY`. Closes the **[confirm]** list first
   and updates `docs/research/mcp.md` with what the package's types say.
7. **`tests/helpers/mcp.ts`** and the protocol-level tests (a real `tools/list` and
   `tools/call` over the route), the secret-scan additions, then the documentation.

Steps 1–5 deliver the maintenance property (Story 3) and the testable guarantees in full.
Steps 6–7 are the only ones that can stall, and they stall on an install, not on a decision.

### Key design points, in one place

- One flat argument object per tool; unknown arguments refused by name, because not every
  body schema is a `z.strictObject` and Zod would otherwise strip an invented field (D7).
- `inputSchema` is self-contained: local `$ref`s inlined, `$defs` and `$schema` dropped.
- The `confirm` check runs before any request is built, so a refusal has no side effect and
  no rate-limit cost.
- `initialize`/`tools/list` resolve the key; a `tools/call` lets the pipeline do the single
  counting resolution, so a tool call costs one request (D16, and the one ordered
  consequence is stated in the transport contract).
- A failed tool call is a tool result with `isError: true` carrying the API's error body, so
  the model can correct itself; a failed listing is a JSON-RPC error, because no tool ran.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New runtime dependency `@modelcontextprotocol/sdk` (constitution VI) | MCP is a wire protocol with a dated revision, a handshake, version negotiation and header rules that change between revisions (`docs/research/mcp.md` §1–2). Constitution I forbids writing it from memory and constitution VI forbids hand-rolling a substitute. The package is the specification's own TypeScript implementation and the only source of truth reachable from a pipeline phase. | A hand-written JSON-RPC endpoint would be a guess at the current revision and would rot at the next one. `mcp-handler` or another Next.js wrapper would be a *second* dependency on top of this one, for plumbing that is one file. Using only the SDK's exported schemas and types while writing the `Request`→`Response` plumbing ourselves is the documented fallback if its transport cannot be driven from a WHATWG `Request` — that keeps the message definitions in the package and is not a substitute for it. |
| A required field added to an existing shared interface (`ApiOperation.mcp`) | FR-001 and SC-002: an operation must not be able to exist without an MCP decision, and the decision must be made in the edit that adds the operation. | An optional field, a lookup table or a predicate over `permission`/`tag` all let a new operation inherit a default silently — the defect spec constraint 3 identifies. The cost is a one-line edit to 34 existing operations, paid once. |
| Moving `errorStatuses`/`codesFor` out of `openapi.ts` | FR-006 requires the tool descriptions to derive failures with "the same logic the OpenAPI document uses". | Copying the derivation guarantees drift the first time an error code is added. Importing `openapi.ts` from the MCP layer would pull the whole document builder, and `zod-openapi`, in to generate a sentence. |

## Post-design constitution re-check

- **I**: unchanged — one residual, `protocol.ts`, explicitly gated on reading the installed
  package's types, with the open items enumerated in `docs/research/mcp.md`.
- **II**: the design makes every requirement except the protocol handshake provable against
  a real database before the dependency lands.
- **III**: the design removed the last plausible isolation risk by ruling out a direct
  `op.run(scope, …)` call: the MCP layer never holds a scope at all for a tool call.
- **IV**: strengthened — one shared error-surface derivation instead of two, and one shared
  test fixture table instead of two.
- **V**: unchanged; no provider or scheduler code is touched.
- **VI**: one dependency, justified above; no new container, port, queue or cache. No
  database change, so `pnpm db:check` is unaffected.
- **VII**: the design adds exactly one new response path, and it is covered by the existing
  secret scan rather than by a new one.

**Verdict: PASS.** No gate fails. Two things are deliberately left open for the phases that
follow: the dependency install, and the reviewer's ruling on the conditional confirmation
for `docket_generate_post`.
