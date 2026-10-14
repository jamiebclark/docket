# Quickstart: prove the MCP front door works

**Feature**: `074-mcp-server` | **Plan**: [plan.md](./plan.md)

## Prerequisites

- Node 24 LTS, pnpm, `pnpm install` run **inside this worktree** (a worktree has no
  `node_modules` of its own).
- Postgres for the integration suite. Locally that is port **5555**, not the 5432 in
  `.env.example` — see `docs/getting-started.md`.
- `@modelcontextprotocol/sdk` installed. Until it is, the protocol tests are skipped and
  everything else below still runs; see `NEEDS DEPENDENCY` in
  [research.md](./research.md).

## 1. The checks that need no MCP client and no SDK

```bash
pnpm vitest run tests/unit/mcp                       # naming, schema, descriptions, dispositions
pnpm vitest run tests/integration/api/mcp-surface.test.ts    # drift: table <-> tool list
pnpm vitest run tests/integration/api/openapi.test.ts        # the errorStatuses extraction changed nothing
pnpm typecheck                                               # an operation without a disposition cannot compile
```

Expected:

- 19 tools, 15 withheld, every withheld one carrying a reason (FR-003, SC-008);
- the nineteen names equal `PUBLISHED_TOOL_NAMES` (FR-004);
- every tool's `inputSchema` is an object with no `$ref` and no `$defs`, whose property
  names are exactly the operation's path, query and body fields plus `confirm`/
  `idempotencyKey` where they apply (FR-005);
- every description contains the project name, the permission, each derived error code,
  and for the five confirmation tools the effect and the word `confirm` (FR-007, SC-006);
- the OpenAPI document test passes **unedited**.

To see the drift test earn its keep, delete the `mcp` field from one operation with
`// @ts-expect-error` and re-run `mcp-surface.test.ts`: it must fail naming that operation
id, not fail somewhere else.

## 2. Permissions, isolation and equivalence against a real database

```bash
pnpm vitest run tests/integration/api/mcp-tools.test.ts
```

Driven from `tests/helpers/api-fixtures.ts`, the same per-operation fixtures the HTTP scope
test uses, and `world()`'s two projects:

- for each of the 19 tools: no key → `invalid_api_key`; a key holding every permission
  except the tool's → `missing_permission` naming it, with no side effect; the right key →
  neither (FR-012, FR-013, SC-003);
- for each tool taking a resource id: project B's id answers 404 byte-identically to an id
  that exists nowhere (FR-017, FR-018);
- for each tool: the tool result equals the result of the same call through
  `tests/helpers/api.ts` with the same key (SC-009);
- the five confirmation tools, called without `confirm` and with `"true"`, `1` and
  `false`: refused `confirmation_required`, and a before/after snapshot of the post,
  slot and project rows is unchanged (FR-020, SC-005);
- a replayed write with the same `idempotencyKey`: one effect, and the second answer
  carries the replay marker (FR-025);
- a key with a rate limit of 1: the second tool call answers `rate_limited` with a wait,
  and the count is **one per tool call**, not two (FR-015, research D16).

## 3. Secrets

```bash
pnpm vitest run tests/integration/security/secret-scan.test.ts
```

The MCP additions to `routeCalls` — a `tools/list`, a successful `tools/call`, and both
with a tampered key — plus the generated descriptions must contribute no secret to the
corpus (FR-029, SC-007).

## 4. End to end with a real client (manual, once)

```bash
pnpm dev
```

1. In the browser: **Settings → API keys → Create key**, tick `read`, `generate`,
   `write_posts` and `manage_setup`, copy the `dkt_…` secret.
2. Configure any MCP client with the endpoint `http://localhost:3000/api/mcp` and a header
   `Authorization: Bearer dkt_…`.
3. Ask it what is scheduled this week and what failed — it should call
   `docket_list_upcoming_slots` and `docket_list_activity`.
4. Ask it to write a post for an account — `docket_generate_post`.
5. Ask it to queue the post. It must refuse once, quoting the effect and `confirm`; say yes
   and it queues (SC-001, SC-005).
6. Point a second client at the same endpoint with a *different project's* key and confirm
   the descriptions name that project and no resource of the first is reachable (FR-016).

Steps 4 and 5 need a configured LLM credential; without one the generate tool answers
`generation_not_configured`, which is itself the expected answer (spec edge case).

## 5. What "done" looks like

`pnpm lint && pnpm typecheck && pnpm test` green, `pnpm build` green (a route was added),
`docs/mcp.md` published and in the mkdocs nav, `docs/n8n.md` and `docs/security.md`
cross-referencing it, and 074's entry appended to `docs/decisions.md`. No migration, so
`pnpm db:check` is unaffected.
