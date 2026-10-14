---

description: "Task list for 074-mcp-server"
---

# Tasks: An MCP server over the v1 API

**Input**: Design documents from `/specs/074-mcp-server/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tools.md, contracts/mcp-transport.md, quickstart.md

**Tests**: Requested by the spec (drift test, permission/isolation/equivalence tests, secret-scan coverage) — included throughout.

**Organization**: Tasks are grouped by user story per the plan's build order (research D-numbers and plan §"Build order" explain why this order survives the blocked dependency). Steps 1–5 of that order need no SDK; steps 6–7 do.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 (read + compose/queue), US2 (setup), US3 (drift/maintenance property)

## Path Conventions

Single Next.js project. Source under `src/`, tests under `tests/`, docs under `docs/`.

---

## Phase 1: Setup

**Purpose**: Confirm the dependency's actual state so later phases know what they can and cannot run. **Update since planning**: `@modelcontextprotocol/sdk@1.32.1` was installed by an operator commit (`b11b4b1`, 2026-10-14) after the plan was written, and `docs/research/mcp.md` was updated with facts read from its installed types — Phase 6 is therefore no longer blocked on an install, only on the one remaining `[confirm]` item below.

- [X] T001 Confirm `@modelcontextprotocol/sdk` is present in `package.json`/`node_modules/` at the version `docs/research/mcp.md` §1 records, and that the file's **[confirm]** list in §2 is only the `McpServer`/`Server` tool-registration API and the Zod-vs-JSON-Schema question (`zod-compat.js`/`zod-json-schema-compat.js`) — if more has drifted, update research.md before building on it

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The required `mcp` field on `ApiOperation`, applied everywhere, and the extracted error-surface module. Nothing in Phase 3+ can be written until every operation (real and test-fixture) compiles with a disposition.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete and `pnpm typecheck` passes.

- [X] T002 Add `McpConfirm` and `McpDisposition` types and the required `mcp: McpDisposition` field to `ApiOperation` in `src/server/api/operations/types.ts`, per data-model.md §1
- [X] T003 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/accounts.ts` per data-model.md §2 (listAccounts: exposed)
- [X] T004 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/activity.ts` per data-model.md §2 (listActivity: exposed)
- [X] T005 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/posts.ts` per data-model.md §2 (getPost: exposed; createPost: exposed+idempotent; queuePost: exposed+confirm+idempotent; schedulePost: exposed+confirm+idempotent)
- [X] T006 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/targets.ts` per data-model.md §2 (getPostTarget: exposed; retryPostTarget/resolvePostTarget/retryFailedTargets: withheld — ambiguous-publish recovery path)
- [X] T007 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/media.ts` per data-model.md §2 (listMedia/getMedia: exposed; uploadMedia: withheld — multipart; registerMediaFromUrl: withheld — arbitrary URL fetch)
- [X] T008 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/generate.ts` per data-model.md §2 and research D9 (generatePost: exposed with conditional `confirm.when` on `schedulingPolicy` present and not `leave_as_draft`, `confirm.effect`/`whenDescription` stating the generate-then-queue effect)
- [X] T009 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/slots.ts` per data-model.md §2 (listUpcomingSlots/addSlot/addWeekSlots/updateSlot: exposed, deleteSlot: exposed+confirm)
- [X] T010 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/jobs.ts` per data-model.md §2 (all nine job operations: withheld — bulk-generation/one-way reasons from data-model.md §2 table)
- [X] T011 [P] Add `mcp` disposition to `src/server/api/operations/openapi.ts` per data-model.md §2 (getOpenApi: withheld — public/unauthenticated, largest response)
- [X] T012 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/projects.ts` per data-model.md §2 (createProject: exposed+confirm+idempotent)
- [X] T013 [P] Add `mcp` dispositions to every operation in `src/server/api/operations/voice.ts` per data-model.md §2 (createVoiceProfile/updateVoiceProfile/setAccountPostingInstructions: exposed+idempotent)
- [X] T014 Add `mcp: { expose: false, reason: "test-only operation" }` to the throwaway operations built with `defineOperation` in `tests/integration/api/errors.test.ts`, `tests/integration/api/idempotency.test.ts`, `tests/integration/api/idempotency-generate.test.ts`, `tests/integration/api/openapi.test.ts`, `tests/integration/api/pipeline.test.ts` (research §"Build order" step 1 — these splice into/out of `OPERATIONS` in `beforeAll`/`afterAll`)
- [X] T015 Run `pnpm typecheck` and confirm it fails loudly on any operation still missing `mcp` before fixing, then confirm it passes once T002–T014 are complete (SC-002's compile-time half)
- [X] T016 Extract `errorStatuses` and `codesFor` out of `src/server/api/openapi.ts` into new `src/server/api/error-surface.ts` as `errorStatuses(op)` and `codesForStatus(status)`, and rewire `openapi.ts` to import them with no behaviour change (research D8)
- [X] T017 Run `pnpm vitest run tests/integration/api/openapi.test.ts` unedited and confirm it stays green, proving the T016 extraction was neutral

**Checkpoint**: `pnpm typecheck` and the OpenAPI test are green. Every operation has a disposition. The error-surface module exists. User story work can now begin.

---

## Phase 3: User Story 3 - A new operation becomes a tool, or is withheld, in one edit (Priority: P2)

**Goal**: The derivation (dispositions → names → schemas → descriptions) and the drift test that makes the maintenance property real — buildable and fully testable with no MCP client and no SDK.

**Independent Test**: Add a throwaway operation to a fixture table without a disposition and confirm the drift test fails naming it; give it one and confirm it appears in (or is absent from) the derived tool list with a generated name, schema and description.

### Tests for User Story 3

- [X] T018 [P] [US3] Unit tests for `dispositionProblems` in `tests/unit/mcp/dispositions.test.ts`: empty for `OPERATIONS`; non-empty and naming the right operation id for a fixture table with a disposition removed, an empty withheld reason, or a confirm missing `effect`/`whenDescription` (data-model.md §1 validation rules, spec User Story 3 acceptance 1)
- [X] T019 [P] [US3] Unit tests for `toolNameFor` and `PUBLISHED_TOOL_NAMES` in `tests/unit/mcp/naming.test.ts`: the camelCase→`docket_`+snake_case derivation for every operation id in `OPERATIONS`, and the full nineteen names asserted against the committed list (FR-004)
- [X] T020 [P] [US3] Unit tests for `argumentSchemaFor`/`inputSchemaFor`/`argumentNamesFor` in `tests/unit/mcp/schema.test.ts`: inlined JSON Schema has no `$ref`/`$defs`/`$schema`; property names equal exactly the operation's params+query+body fields plus `confirm`/`idempotencyKey` where applicable; a path/query/body name collision across the whole table fails the test by naming the operation (research D7)
- [X] T021 [P] [US3] Unit tests for `describeTool` in `tests/unit/mcp/describe.test.ts`: every exposed tool's description contains the project name, the exact permission value, each derived failure code from `errorStatuses`/`codesForStatus`, and — for confirmation tools — the effect text and the word "confirm"; `docket_generate_post`'s description additionally states the LLM-budget cost, the auto-approve skip-review behaviour, and that a validation failure still forces review (FR-006, FR-007, FR-026)
- [X] T022 [US3] Drift test in `tests/integration/api/mcp-surface.test.ts`: `dispositionProblems(OPERATIONS)` is empty; the derived tool list is exactly the 19 exposed operations (no orphan tools, no un-toolled exposures — FR-003, FR-014); tool names equal `PUBLISHED_TOOL_NAMES`; each tool's permission and input-schema field set matches its operation; deleting the `mcp` field from one operation via `// @ts-expect-error` on a local fixture makes the test fail naming that operation id (quickstart.md §1)

### Implementation for User Story 3

- [X] T023 [P] [US3] Implement `src/server/mcp/dispositions.ts`: `EXPOSED`, `WITHHELD`, `dispositionProblems` per contracts/mcp-transport.md §3
- [X] T024 [P] [US3] Implement `src/server/mcp/naming.ts`: `toolNameFor`, `PUBLISHED_TOOL_NAMES` per contracts/mcp-transport.md §4 and research D13
- [X] T025 [US3] Implement `src/server/mcp/schema.ts`: `argumentSchemaFor`, `inputSchemaFor` (with `$ref` inlining, `$defs`/`$schema` dropped), `argumentNamesFor` per contracts/mcp-transport.md §5 and research D7 (depends on T023 for `AnyApiOperation`/disposition shapes)
- [X] T026 [US3] Implement `src/server/mcp/describe.ts`: `describeTool` (four required parts plus confirmation/generate-specific sentences) and `toolsFor(scope)` per contracts/mcp-transport.md §6 and data-model.md §5 (depends on T024, T025, T016)

**Checkpoint**: `pnpm vitest run tests/unit/mcp tests/integration/api/mcp-surface.test.ts` green. Adding a disposition to a new operation now produces a correctly named, schema'd, described tool with no other file touched. This is SC-002, SC-006 and SC-008's substance, fully provable without the SDK.

---

## Phase 4: User Story 1 - Read a brand's state and compose a post from a chat client (Priority: P1) 🎯 MVP

**Goal**: Every exposed tool runs through the real pipeline — authentication, rate limiting, permission checks, confirmation, idempotency, equivalence to the same HTTP call — provable with no protocol byte, via the bridge directly.

**Independent Test**: Configure one project's key, call the read and compose/queue tools through the bridge/test helper and compare their results against the same operations called over HTTP with the same key; call the queue tool first without confirmation (refusal, no change) then with it (queued).

### Tests for User Story 1

- [X] T027 [US1] Extract `FIXTURES`, `fill` and `call` out of `tests/integration/api/scope-enforcement.test.ts` into new `tests/helpers/api-fixtures.ts`, unchanged, and update `scope-enforcement.test.ts` to import them with no assertion changed (research D11); run `pnpm vitest run tests/integration/api/scope-enforcement.test.ts` and confirm it stays green
- [X] T028 [P] [US1] New `tests/helpers/mcp-bridge.ts`: a test helper that flattens a fixture's params/query/body into one argument object and drives `callTool` directly (no protocol layer), mirroring how `tests/helpers/api.ts` drives the route
- [X] T029 [US1] Integration test in `tests/integration/api/mcp-tools.test.ts`, read/compose/queue portion: for `docket_list_accounts`, `docket_list_activity`, `docket_get_post`, `docket_get_post_target`, `docket_list_media`, `docket_get_media`, `docket_list_upcoming_slots`, `docket_create_post`, `docket_generate_post`, `docket_queue_post`, `docket_schedule_post` — no key → `invalid_api_key`; a key missing the tool's permission → `missing_permission` naming it, no side effect; the right key → neither; tool result equals the result of the same call through `tests/helpers/api.ts` with the same key (FR-012, FR-013, SC-003, SC-009)
- [X] T030 [US1] Extend T029's suite: for each of those tools that takes a resource id, project B's id answers 404 byte-identically to an id that exists nowhere (FR-017, FR-018)
- [X] T031 [US1] Extend T029's suite: `docket_queue_post` and `docket_schedule_post` called without `confirm`, and with `"true"`, `1`, `false` — refused `confirmation_required` naming the effect and the argument, before/after snapshot of the post row unchanged; called with `confirm: true` — queued/scheduled exactly as the HTTP operation would (FR-020, FR-021, SC-005, spec User Story 1 acceptance 4–5)
- [X] T032 [US1] Extend T029's suite: `docket_generate_post` without `schedulingPolicy` or with `leave_as_draft` — no confirmation demanded; with another `schedulingPolicy` and no `confirm` — refused `confirmation_required`; with `confirm: true` — generated and queued (research D9, data-model.md §2 `C*`)
- [X] T033 [US1] Extend T029's suite: a replayed write (`docket_create_post`, `docket_queue_post`, `docket_schedule_post`, `docket_generate_post`) with the same `idempotencyKey` produces one effect and the second answer carries the replay marker; a mismatched-body replay and an in-flight duplicate behave exactly as `runIdempotent` does over HTTP (FR-025)
- [X] T034 [US1] Extend T029's suite: a key with `rate_limit_per_minute: 1` — the second tool call (of any tool) answers `rate_limited` with a wait, and the count is one per tool call, not two (FR-015, research D16)

### Implementation for User Story 1

- [X] T035 [US1] Implement `src/server/mcp/bridge.ts`: `callTool(name, args, request)` per contracts/mcp-transport.md §7 and research D6 — resolve tool by name, reject unknown arguments, check `confirm` before any IO, pass `idempotencyKey` through, build the `Request` (path fill, query string, JSON body, credential headers, `Idempotency-Key`), call `handleApiRequest`, read status/body/`Retry-After`/`Idempotent-Replayed`, set `isError` from `status >= 400` (depends on T023, T025, T026)
- [X] T036 [US1] Add `src/server/mcp/**` to the `pipeline` list (no database client import) in `tests/lint/api-imports.test.ts` per research D12; run it and confirm green

**Checkpoint**: `pnpm vitest run tests/integration/api/mcp-tools.test.ts tests/lint/api-imports.test.ts` green for the read/compose/queue tools. User Story 1's pipeline equivalence, confirmation and idempotency guarantees hold for every one of its tools, driven through the bridge with no SDK required.

---

## Phase 5: User Story 2 - Stand a brand up conversationally (Priority: P2)

**Goal**: The eight `manage_setup` tools (project, voice profile, posting instructions, slots) through the same bridge, including the `createProject` and `deleteSlot` confirmations and idempotent replay for setup writes.

**Independent Test**: With a `manage_setup` key, call the project, voice-profile, posting-instructions and slot tools in sequence through the bridge; confirm via the read tools; replay each write with the same idempotency argument and confirm nothing is duplicated.

### Tests for User Story 2

- [X] T037 [US2] Extend `tests/integration/api/mcp-tools.test.ts`: for `docket_create_project`, `docket_create_voice_profile`, `docket_update_voice_profile`, `docket_set_account_posting_instructions`, `docket_add_slot`, `docket_add_week_slots`, `docket_update_slot`, `docket_delete_slot` — no key → `invalid_api_key`; a key missing `manage_setup` → `missing_permission` naming it, no write; the right key → neither; result equals the same call through `tests/helpers/api.ts` (FR-012, FR-013, SC-003, SC-009, spec User Story 2 acceptance 6)
- [X] T038 [US2] Extend the suite: `docket_create_project` without `confirm` — refused, message says the slug is permanent and the project cannot be removed, no project created; with `confirm: true` and an unused slug — project exists with submitted fields, result matches the HTTP body; with a slug held by a project the calling key cannot see — the same conflict code/message/details as a slug held by a visible project (FR-020, FR-021, spec User Story 2 acceptance 1–3)
- [X] T039 [US2] Extend the suite: `docket_delete_slot` without `confirm` — refused, slot still exists; with `confirm: true` — slot gone (spec User Story 2 acceptance 5)
- [X] T040 [US2] Extend the suite: book a full week via `docket_add_week_slots` then replay with the same `idempotencyKey` — slots exist once, second call replays the first result (FR-025, spec User Story 2 acceptance 4)

### Implementation for User Story 2

- [X] T041 [US2] No new production code expected beyond T023–T026/T035 (dispositions, schema, describe and bridge are generic over every operation); if T037–T040 surface a gap specific to the setup operations (e.g. a schema or description edge case), fix it in the relevant `src/server/mcp/*.ts` file and note which — **outcome**: no `src/server/mcp/*.ts` gap surfaced; the only fix needed was in the test harness itself (`tests/integration/api/mcp-tools.test.ts`'s generic equivalence loop called `fx.body()` twice, so `createProject`'s randomly-generated fixture body differed between the HTTP and MCP calls sharing one idempotency key, tripping `idempotency_key_reused`; fixed by computing the body once and passing it to both calls)

**Checkpoint**: `pnpm vitest run tests/integration/api/mcp-tools.test.ts` green end to end for all 19 tools (Stories 1 and 2 combined). Every FR about permissions, isolation, confirmation and idempotency is now proven for the whole exposed surface, still with no SDK.

---

## Phase 6: Protocol layer (needs the one remaining `[confirm]` item closed)

**Purpose**: The only phase that touches `@modelcontextprotocol/sdk`. Everything above is independently shippable and testable without it; this phase wires the proven bridge to the actual wire protocol. The dependency itself is already installed (T001) — the only thing still open is reading the SDK's tool-registration API, not waiting for an install.

- [X] T042 Close the last **[confirm]** item in `docs/research/mcp.md` §2: read `node_modules/@modelcontextprotocol/sdk`'s `zod-compat.js`/`zod-json-schema-compat.js` and the `McpServer`/`Server` tool-registration API to settle whether `inputSchemaFor`'s JSON Schema output (T025) is registered directly or needs adapting, and update `docs/research/mcp.md` with what was found, citing the package path
- [X] T043 Implement `src/server/mcp/protocol.ts` (`handleMcpRequest(request)`) per contracts/mcp-transport.md §2 and `docs/research/mcp.md` §2–4 (the `2025-11-25` era the installed SDK implements — the handshake, header rules and error codes the file already settled): JSON-RPC envelope, `initialize`, `tools/list` (resolves the key via `forApiKey`, refused `invalid_api_key` for absent/malformed/revoked/expired, JSON-RPC error on failure since no tool ran), `tools/call` (credential-shape check only, then `callTool` from T035, `isError: true` tool result on failure per research D5/D14), built on `WebStandardStreamableHTTPServerTransport` with no `sessionIdGenerator` (stateless) and `enableJsonResponse: true` (single JSON object, no SSE), `Origin` header check (403 for a disallowed origin), `MCP-Protocol-Version` header rule
- [X] T044 Implement `src/app/api/mcp/route.ts`: `export const runtime = "nodejs"`, `dynamic = "force-dynamic"`, `POST` delegates to `handleMcpRequest`, `GET`/`DELETE` answer 405, per contracts/mcp-transport.md §1
- [X] T045 Add `src/app/api/mcp/**` to the `strict` list (no DAL import) in `tests/lint/api-imports.test.ts`; run it and confirm green
- [X] T046 New `tests/helpers/mcp.ts`: drives the MCP route in-process with a real `tools/list` and `tools/call`, like `tests/helpers/api.ts` drives the v1 route (research §"Build order" step 7)
- [X] T047 Protocol-level integration tests in `tests/integration/api/mcp-tools.test.ts` (or a new file alongside it) using T046: a real `tools/list` returns exactly the 19 tools with descriptions naming the project; a real `tools/call` round-trips through `handleMcpRequest` for at least one read, one write-with-confirm and one setup tool, matching the bridge-level results from Phases 4–5 (spec User Story 1 acceptance 1–2)
- [X] T048 Add the MCP route to `tests/integration/security/secret-scan.test.ts`'s `routeCalls`: a `tools/list`, a successful `tools/call`, and both with a tampered key, per research code facts and quickstart.md §3 (FR-029, SC-007); run it and confirm green

**Checkpoint**: `pnpm vitest run tests/integration/api/mcp-tools.test.ts tests/integration/security/secret-scan.test.ts` green including the protocol-level tests. A real MCP client can now be pointed at `/api/mcp` (quickstart.md §4, manual, once this phase is unblocked).

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation (FR-030 through FR-033) and the full quality-gate sweep.

- [ ] T049 [P] Write `docs/mcp.md`: operator-register guide beside `docs/n8n.md` — creating and configuring a key, which permission each tool needs, the full list of 19 exposed tools (names, effects, confirmations), the withheld 15 operations and their reasons, the two-projects-two-servers rule (FR-031, SC-008)
- [ ] T050 [P] Add a cross-reference from `docs/mcp.md` to `docs/n8n.md` and a new trailing section (no heading renumbered) in `docs/n8n.md` cross-referencing `docs/mcp.md`, per research "Open risks" item 4 (FR-032)
- [ ] T051 [P] Update `docs/security.md`: MCP uses the same keys, the same permissions and the same project scoping, and adds no new credential type or trust boundary (FR-033)
- [ ] T052 Add `docs/mcp.md` to `mkdocs.yml` nav beside the `n8n.md` entry (`strict: true` requires this in the same commit as T049)
- [ ] T053 Append the 074 entry to `docs/decisions.md`: the hosting choice (route in the Next app, not a separate process) and the per-session project rule, with their reasoning and accepted costs, per plan.md D2/D5 (FR-030)
- [ ] T054 Record the D9 judgement (conditional confirmation on `docket_generate_post`) in `docs/decisions.md` as the one open call for a reviewer to accept or reverse, per research.md "Open risks" item 5
- [ ] T055 Run the full quality gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, and `pnpm db:check` (expected unaffected — no migration), per quickstart.md §5 "what done looks like"
- [ ] T056 [Human-owned, needs a signed-in browser session and a real MCP client] Manual end-to-end pass per quickstart.md §4: create a key, configure a client, ask what's scheduled/failed, generate a post, queue it (confirm once refused, once accepted), then point a second client at a different project's key and confirm isolation. Depends on Phase 6 being complete; if Phase 6 is not yet done by the time this entry is reviewed, mark this task as blocked-on-Phase-6 rather than done or skipped

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Phase 1. BLOCKS every later phase — no operation file, test file or `src/server/mcp/*` module can be written against a type that doesn't exist yet.
- **User Story 3 (Phase 3)**: Depends on Phase 2 (the `mcp` field and `error-surface.ts`). Independent of Phases 4–5.
- **User Story 1 (Phase 4)**: Depends on Phase 3 (`dispositions.ts`, `schema.ts`, `describe.ts` feed `bridge.ts`).
- **User Story 2 (Phase 5)**: Depends on Phase 3, and reuses the bridge from Phase 4 (T035) — in practice runs after or alongside Phase 4.
- **Protocol (Phase 6)**: Depends on Phases 3–5 (needs a working `callTool`) AND on the external dependency install. Can stall independently of everything else.
- **Polish (Phase 7)**: Documentation tasks (T049–T054) depend only on Phases 2–5 being done (the surface is fixed); T055 depends on everything compiling; T056 depends on Phase 6.

### Within Each User Story

- Tests are written first per story and must fail before the corresponding implementation task (T018–T022 before T023–T026; T027–T034 before T035; T037–T040 before T041).
- Models/schema before services/description before bridge before route.

### Parallel Opportunities

- All of T003–T013 (per-operation-file disposition tasks) are `[P]` — different files, same shape of edit.
- T018–T021 (US3 unit tests) are `[P]` — different files.
- T023, T024 are `[P]`; T025 depends on T023, T026 depends on T024+T025+T016.
- T049–T051 (docs) are `[P]`.

---

## Parallel Example: Phase 2 foundational disposition tasks

```bash
Task: "Add mcp dispositions to src/server/api/operations/accounts.ts"
Task: "Add mcp dispositions to src/server/api/operations/activity.ts"
Task: "Add mcp dispositions to src/server/api/operations/posts.ts"
Task: "Add mcp dispositions to src/server/api/operations/targets.ts"
Task: "Add mcp dispositions to src/server/api/operations/media.ts"
Task: "Add mcp dispositions to src/server/api/operations/generate.ts"
Task: "Add mcp dispositions to src/server/api/operations/slots.ts"
Task: "Add mcp dispositions to src/server/api/operations/jobs.ts"
Task: "Add mcp disposition to src/server/api/operations/openapi.ts"
Task: "Add mcp dispositions to src/server/api/operations/projects.ts"
Task: "Add mcp dispositions to src/server/api/operations/voice.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only, protocol-free)

1. Phase 1: Setup.
2. Phase 2: Foundational — the `mcp` field everywhere, `error-surface.ts`.
3. Phase 3: User Story 3 — the derivation and drift test (this is the maintenance property the whole entry buys, so it is built before, not after, the tools that depend on it).
4. Phase 4: User Story 1 — read, compose, generate, queue, schedule, through the bridge.
5. **STOP and VALIDATE**: `pnpm vitest run tests/unit/mcp tests/integration/api/mcp-surface.test.ts tests/integration/api/mcp-tools.test.ts` green for US1's tools.

### Incremental Delivery

1. Foundational + US3 → the derivation is provably correct and self-maintaining.
2. + US1 → the everyday read/compose/queue loop works end to end through the pipeline bridge.
3. + US2 → the setup tools work the same way.
4. + Phase 6 → the actual wire protocol, once the dependency lands.
5. + Phase 7 → documentation and the full gate.

### Why the SDK dependency does not block most of the entry

Phases 2–5 and the documentation half of Phase 7 (T049–T054) touch no file that imports
`@modelcontextprotocol/sdk`. The install itself landed between planning and this task list
(`b11b4b1`), so only the registration-API question in T042 and the protocol work that
follows it (T043–T048, T056) were ever at risk of stalling — exactly the plan's "steps 1–5
deliver the maintenance property and the testable guarantees in full; steps 6–7 are the only
ones that can stall."

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability (US1/US2/US3); Phases 1, 2, 6, 7 carry no story label (setup/foundational/protocol/polish, per the template's rule).
- Commit after each completed task or small group of tightly related tasks, per the constitution's commit discipline (explicit paths, Conventional Commits, no `git add -A`).
- Every operation-file disposition task (T003–T013) and the two drift-adjacent test tasks (T014, T022) should be committed together with the type change (T002) once `pnpm typecheck` passes (T015), so no commit in between has a half-declared operation.
- T042/T056 name exactly what they are blocked on (`@modelcontextprotocol/sdk`) per this pipeline's rule that a human-owned or dependency-blocked task must say what it is waiting for.
