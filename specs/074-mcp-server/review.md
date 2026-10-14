# Review: An MCP server over the v1 API (074)

Reviewed 59 file(s) changed across 12 commit(s), against `406e426...HEAD` (`git merge-base HEAD origin/main`).

Read in full: `src/server/mcp/{types,dispositions,naming,schema,describe,bridge,protocol}.ts`,
`src/app/api/mcp/route.ts`, `src/server/api/error-surface.ts`,
`src/server/api/operations/types.ts`, the whole `src/server/api/operations/` diff (all 34
dispositions), the `src/server/api/openapi.ts` diff, `tests/unit/mcp/*.test.ts`,
`tests/integration/api/{mcp-surface,mcp-tools,mcp-protocol,scope-enforcement}.test.ts`,
`tests/helpers/{api-fixtures,mcp-bridge,mcp}.ts`, `tests/lint/api-imports.test.ts`,
the `secret-scan.test.ts` diff, `docs/mcp.md`, and the `docs/{decisions,n8n,security}.md` +
`mkdocs.yml` diffs. Also read, as the obligation sources and the pre-existing code the
feature leans on: `spec.md`, `plan.md`, `tasks.md`, `data-model.md`,
`contracts/mcp-transport.md`, `.specify/memory/constitution.md`,
`src/server/api/{handle,auth,errors,respond,idempotency}.ts`,
`src/server/services/generation/{policy,single}.ts`, `src/lib/validation/policies.ts`,
`src/server/db/schema/projects.ts`.

Sampled: `specs/074-mcp-server/research.md` (D5-D16, the decisions the code is measured
against), `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js` (to settle who
answers `initialize`).

Not reviewed: `docs/research/mcp.md` for factual accuracy against the official MCP
specification (this phase cannot fetch the cited pages - see "What I could not check"),
`specs/074-mcp-server/{quickstart,contracts/mcp-tools}.md`, `pnpm-lock.yaml`.

## Verdict

The architecture is right and the hard part landed well: the disposition field is genuinely
required, the 34 operations are each decided, the 19 tools are derived end to end (name,
schema, description, permission), and a tool call really is one `Request` through
`handleApiRequest` - so FR-011's "no second pipeline" is structural rather than asserted.
Phases 2-5 are solid, and the drift test, the permission loop over all 19 tools and the
idempotency tests are real tests of real behaviour.

What did not survive the pass boundary is the **protocol layer**. Phase 4's bridge returns
`Retry-After` and `Idempotent-Replayed` in `McpToolOutcome.headers`; Phase 6's `tools/call`
handler never reads them, so over the wire a rate-limited model is told to slow down with no
wait and a replay is invisible (F1) - and because Phase 4's tests assert at the bridge, not
the wire, nothing caught it. Two more defects cluster on `docket_generate_post`, whose
conditional confirmation is both too narrow (it reads the *requested* scheduling policy, not
the resolved one, so a project configured to auto-approve and queue publishes to live
accounts with no confirmation - F2) and, in its published JSON Schema, unconditionally
required (so a schema-following client either cannot make the plain generate-to-draft call
the docs promise, or always passes `confirm: true` and renders the gate a no-op - F3). These
two must be fixed together: fixing F3 alone makes F2 easier to reach. Beyond that, the bridge
forwards only `Authorization`, so a key presented the other way `docs/n8n.md` documents lists
tools fine and fails every call (F4); the new cross-project test silently skips three of the
nine exposed tools that take a resource id (F5); and the generated "Can fail with" sentence
lists each operation's *residual* statuses, so `docket_create_project` never mentions
`conflict` or `missing_permission` (F6).

None of this is architectural rework - F1, F3, F4 and F6 are a few lines each in one file,
F2 is a predicate, F5 is three map entries. Fix the six MAJORs and this is ready. Nothing
found would corrupt data, leak a secret or cross a project boundary.

## Findings

- [ ] MAJOR F1 — The protocol layer throws away the pipeline's `Retry-After` and `Idempotent-Replayed`, so a tool call never reports the wait or the replay.
      where:  src/server/mcp/protocol.ts:63, src/server/mcp/bridge.ts:102
      why:    `callTool` carefully lifts `Retry-After` and `Idempotent-Replayed` into
              `McpToolOutcome.headers` (bridge.ts:102-108), and the `tools/call` handler
              returns only `{ content, isError }` — the headers are dropped. `handle.ts:140`
              puts the rate-limit wait **only** in the header (`details` is `undefined`), so
              a model that hits the limit over MCP receives "Too many requests. Slow down and
              retry." with no number and will retry immediately, which is the exact failure
              FR-015 exists to prevent. The same drop makes a replay indistinguishable from a
              first execution (FR-025's "replay marking"). Research D6 ("the response's
              status, JSON body and `Retry-After`/`Idempotent-Replayed` headers become the
              tool result") and D14 ("plus the wait in seconds when the code is
              `rate_limited`") both specify the opposite, and `docs/mcp.md:66` publishes the
              behaviour as fact. The Phase 4 tests assert both headers
              (mcp-tools.test.ts:282, :320, :335) but only through the bridge, so the wire
              regression is invisible to the suite.
      owed:   Carry the outcome's headers into the `CallToolResult` — append the wait to the
              text content (or the error body's `details`) when the code is `rate_limited`,
              and surface the replay marker — and assert it in a protocol-level test, not
              just a bridge-level one.
      traces: FR-015, FR-025, FR-028, SC-009

- [ ] MAJOR F2 — `docket_generate_post`'s confirmation reads the *requested* scheduling policy, so a project whose default is `add_to_queue` publishes to live accounts unconfirmed.
      where:  src/server/api/operations/generate.ts:70, src/server/services/generation/policy.ts:50
      why:    The predicate is `typeof args.schedulingPolicy === "string" && policy !==
              "leave_as_draft"`, but the effect is decided by the *resolved* policy:
              `resolvePolicies` falls back to `scope.project.defaultSchedulingPolicy`
              (policy.ts:50) and `decidePolicy` queues whenever the resolved pair is
              `auto_approve` + `add_to_queue` (policy.ts:34). Both project defaults are
              settable from the project settings form
              (`src/app/p/[projectSlug]/settings/settings-form.tsx`), so in a project
              configured for hands-off generation, a model calling
              `docket_generate_post { brief, accountIds, confirmUnreviewedQueue: true }` —
              with no `schedulingPolicy` at all — generates, approves and queues the post to
              the brand's live accounts, and `when()` returns false, so no confirmation is
              ever demanded. FR-020 is a MUST about effects, and US1 promises "nothing
              reaches a social account until that confirmation". The `whenDescription`
              published in `docs/mcp.md:29` ("a plain generate-to-draft needs no
              confirmation") is then untrue for that project.
      owed:   Demand the confirmation whenever the call *could* queue — treat an absent
              `schedulingPolicy` as "unknown, therefore confirm", or resolve against the
              project's default before deciding. Fix together with F3. Add a test with a
              project whose defaults are `auto_approve` + `add_to_queue`.
      traces: FR-020, FR-021, SC-005, US1

- [ ] MAJOR F3 — `confirm` is a required property of every confirmation tool's input schema, including the conditionally-confirmed generate tool.
      where:  src/server/mcp/schema.ts:36
      why:    `shape.confirm = z.literal(true)` is not `.optional()`, so
              `z.toJSONSchema(..., { io: "input" })` emits `confirm` in the schema's
              `required` array (verified by running Zod 4.6.5 over the same shape). For the
              four unconditional tools that is faithful. For `docket_generate_post` it
              contradicts data-model.md §2's `C*`, research D9 and `docs/mcp.md:29`: a client
              that validates arguments against `inputSchema` cannot make the plain
              generate-to-draft call at all, and a model that simply follows the schema will
              always send `confirm: true` — which turns the conditional gate into a no-op and
              silently covers F2. No test looks at the `required` array;
              mcp-surface.test.ts:38 compares only the *property names*.
      owed:   Make `confirm` optional in the schema when the disposition carries a `when`
              (keeping the `literal(true)` type so a non-affirmative value is still
              rejected), and assert the `required` array for a conditional tool and for an
              unconditional one.
      traces: FR-005, FR-020, SC-005

- [ ] MAJOR F4 — The bridge forwards only `Authorization`, so a key sent as `X-API-Key` lists tools successfully and then fails every tool call with `invalid_api_key`.
      where:  src/server/mcp/bridge.ts:81, src/server/api/auth.ts:10
      why:    `callTool` validates the credential with `readKey`, which accepts
              `Authorization: Bearer` **or** `X-API-Key` (auth.ts:10), and then builds the
              inner `Request` from a fresh `Headers` into which it copies only
              `authorization` (bridge.ts:80-84). An `X-API-Key`-only request therefore passes
              the shape check, reaches `handleApiRequest` with no credential at all, and is
              refused 401 `invalid_api_key` — while `tools/list` succeeds, because
              `protocol.ts:54` reads the real headers. FR-008 requires the key be "read the
              same ways the HTTP API accepts one", the spec's Decisions say "the key is read
              exactly as `readKey` reads it for HTTP", contracts/mcp-transport.md §7 step 5
              says "the credential headers copied from the MCP request" (plural), and
              `docs/n8n.md:15` tells operators `X-API-Key: dkt_...` also works, with
              `docs/security.md` asserting MCP reads the same keys "the same way". The
              failure mode — listing works, every call is unauthorized — is maximally
              confusing to diagnose.
      owed:   Copy `x-api-key` alongside `authorization` (or forward both credential headers
              verbatim), and cover an `X-API-Key` tool call in the tools test.
      traces: FR-008, FR-009, SC-009

- [ ] MAJOR F5 — The MCP project-isolation test silently skips `profileId` and `slotId`, leaving three of the nine exposed id-taking tools with no cross-project test.
      where:  tests/integration/api/mcp-tools.test.ts:109, tests/integration/api/mcp-tools.test.ts:119
      why:    The `foreign` map holds only `postId`, `targetId`, `mediaId` and `accountId`,
              and line 119 is `if (!(name in foreign)) continue;` — so
              `docket_update_voice_profile` (`resourceParams: ["profileId"]`, voice.ts:65),
              `docket_update_slot` and `docket_delete_slot` (`["slotId"]`, slots.ts:131,
              slots.ts:156) are skipped, and `expect(checked).toBeGreaterThan(0)` passes
              regardless. FR-018 is a MUST for "every exposed tool that takes a resource
              identifier", and SC-003 says a resource from another project is never reachable
              through any tool. The HTTP test this was modelled on carries all eight ids and
              skips nothing (scope-enforcement.test.ts:87-96, which already has
              `w.b.voiceProfile.id` and `w.b.slot!.id` to hand) — so the new front door is
              tested more weakly than the old one, and the `continue` means any future
              resource-param type is skipped silently too.
      owed:   Add `profileId: w.b.voiceProfile.id` and `slotId: w.b.slot!.id`, and replace the
              silent `continue` with a failure when a resourceParam has no foreign fixture
              (or assert the checked count equals the expected set).
      traces: FR-018, SC-003

- [ ] MAJOR F6 — The generated "Can fail with" sentence lists each operation's *residual* statuses, so the better-documented tools name none of the failures that matter.
      where:  src/server/mcp/describe.ts:16, src/server/api/error-surface.ts:19
      why:    `errorStatuses` ends with `for (const s of Object.keys(op.responses)) set.delete(s)`
              — it returns the statuses an operation can answer with *beyond the ones it
              documents itself*, because `openapi.ts` emits the documented ones separately in
              `buildOperation`. `describeTool` uses it as if it were the complete set. For
              `createProject`, whose `responses` are `201` plus `standardErrors("manage_setup")`
              (400/401/403/404/409/422/429), the surviving statuses are 413/415/500, so the
              tool description reads "Can fail with: `payload_too_large`,
              `unsupported_media_type`, `internal_error`" and never mentions `conflict` (the
              taken slug — the one failure US2 acceptance 3 is about), `missing_permission` or
              `validation_failed`. `listActivity` yields only `rate_limited`/`internal_error`;
              `getPost` never mentions `not_found`, the answer the spec's own edge case says a
              foreign id gets. FR-006 requires the description to state "the failure modes it
              can answer with"; reusing the OpenAPI derivation was about not duplicating the
              logic, not about shipping its complement.
              `tests/unit/mcp/describe.test.ts:17` asserts only that whatever `errorStatuses`
              returns appears in the text, so it confirms the implementation against itself and
              locks the gap in (FR-007, SC-006 "verified by test rather than by reading, so it
              cannot rot").
      owed:   Union `errorStatuses(op)` with the `>= 400` keys of `op.responses` before mapping
              to codes, and assert in `describe.test.ts` that a documented failure (e.g.
              `conflict` for `createProject`, `not_found` for `getPost`) appears.
      traces: FR-006, FR-007, SC-006

- [ ] MINOR F7 — `tools/list` counts against the key's rate limit but is never refused when the key is over it.
      where:  src/server/mcp/protocol.ts:54
      why:    `authenticate` returns `forApiKey`'s `{ scope, rate }` and the handler
              destructures only `{ scope }`. `forApiKey` always increments the window
              (`countRequest`, scope.ts:366), so a listing spends a request, but unlike
              `handle.ts:138` nothing compares `rate.count` with `rate.limit` — a key being
              refused 429 on every tool call can still list tools unboundedly, each listing
              pushing the counter further past the limit. FR-015 says the existing rate limit
              "MUST apply to MCP traffic"; today it is counted there but not enforced.
      owed:   Refuse the listing with the same `rate_limited` message and wait when
              `rate.count > rate.limit`.
      traces: FR-015

- [ ] MINOR F8 — `initialize` is served with no key, contrary to FR-009 and the transport contract.
      where:  src/server/mcp/protocol.ts:50
      why:    `newServer()` registers handlers for `tools/list` and `tools/call` only; the SDK
              installs its own `initialize` handler
              (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:52`), which
              authenticates nothing. FR-009 requires authentication "before any MCP request is
              served", and contracts/mcp-transport.md §9 states plainly that "`initialize` and
              `tools/list` resolve the key with `forApiKey(key)`". Impact is small — the
              handshake discloses only the server name, version and capabilities, nothing about
              the project, and the transport is stateless so no session is created — but it is
              an unmetered, unauthenticated endpoint and the contract says otherwise.
      owed:   Either authenticate `initialize` (check the credential in `handleMcpRequest`
              before `transport.handleRequest`), or amend contract §9 and FR-009's reading to
              exclude the handshake, with the reason.
      traces: FR-009

- [ ] MINOR F9 — A refused `tools/list` carries no `invalid_api_key` code, only the JSON-RPC code.
      where:  src/server/mcp/protocol.ts:37
      why:    `throw new McpError(ErrorCode.InvalidRequest, "Invalid API key.")` produces
              `{ code: -32600, message: "Invalid API key." }` with no `data`. The message
              matches the HTTP API's, but FR-009 asks for "the same code and message", and the
              spec's Decisions say a listing "gets the same `invalid_api_key` refusal ... as for
              a tool call". A client cannot branch on a stable code.
              mcp-protocol.test.ts:37 only asserts that *an* error came back, so the code is
              unconstrained.
      owed:   Attach the API error body as the `McpError`'s `data` and assert the
              `invalid_api_key` code in the protocol test.
      traces: FR-009, FR-028

- [ ] MINOR F10 — Bridge-level refusals carry an empty `requestId`.
      where:  src/server/mcp/bridge.ts:26
      why:    `outcomeFor` calls `errorBody(e, "")`, so the three refusals the bridge answers
              itself — `invalid_api_key`, `validation_failed` for an unknown argument, and
              `confirmation_required` — return `error.requestId: ""`. FR-028 requires the error
              shape's "stable code, human message and request id", and `docs/mcp.md:66`
              promises "the same code, human message and request id the public API would give".
              The equivalent HTTP call always carries a uuid.
      owed:   Mint a request id in `callTool` (or accept one) and pass it to `errorBody`.
      traces: FR-028, SC-009

- [ ] MINOR F11 — `WITHHELD` is exported and used nowhere; the 15 published reasons are a hand copy no test ties to the field.
      where:  src/server/mcp/dispositions.ts:8, docs/mcp.md:49
      why:    Nothing in `src/`, `tests/` or `scripts/` imports `WITHHELD` (grepped) — it is a
              dead end from Phase 3 that no later pass wired in. FR-024 asks for each reason to
              be "recorded alongside its declaration and published in the documentation", and
              the documentation's table is a manual transcription of the `reason` strings, so
              editing a reason in the operation table leaves the published list stale with
              nothing failing. The export that exists to prevent exactly that is unused.
      owed:   Either drive a test (or the page) from `WITHHELD` so the published reasons cannot
              drift from the field, or delete the export and say in the code that the
              documentation is the published copy.
      traces: FR-024, SC-008

- [ ] MINOR F12 — The new runtime dependency has no decision entry of its own in `docs/decisions.md`.
      where:  docs/decisions.md:3304
      why:    Constitution VI: "Adding any other runtime dependency ... requires a
              justification in plan.md and an entry in `docs/decisions.md`." plan.md's
              Complexity Tracking carries the justification, and the 074 entry names
              `@modelcontextprotocol/sdk` in its implementation-outcome paragraph, but the
              dependency gets none of the treatment the entry's other two decisions get — no
              accepted cost, no reversal path — so the one judgement a future reader is most
              likely to revisit is the one not written down as a decision.
      owed:   Add a third bullet to the 074 entry for the dependency: why the SDK rather than a
              hand-rolled JSON-RPC endpoint, the accepted cost, and how to reverse it (the
              fallback already written in plan.md's Complexity Tracking).
      traces: Constitution VI, FR-030

- NOTE F13 — **Ruling on the one open judgement the plan asked a reviewer to settle**
  (plan.md:190, research D9, `docs/decisions.md`'s "One open judgement"): keep the conditional
  confirmation on `docket_generate_post`. FR-020 is written about *effects* ("operations whose
  effect is irreversible or destructive"), not about the four tool names FR-021 happens to
  list, and generate-then-queue publishes to live accounts in one call. Do not reverse it — but
  it is only worth keeping if F2 and F3 are fixed, because as it stands the gate misses the
  project-default path and is schema-required anyway.

- NOTE F14 — The write-tool half of the equivalence proof (mcp-tools.test.ts:92-100) works by
  sending the HTTP call and the MCP call with the *same* `Idempotency-Key`, so the MCP answer is
  `runIdempotent`'s replay of the HTTP one. That is a genuine proof that the bridge built the
  same method, route and canonical body (a mismatch would be 422 `idempotency_key_reused`), but
  it is not two independent executions compared — worth knowing before trusting it as
  response-level equivalence. The seven reads are compared independently.

- NOTE F15 — Research D15 said the missing `listPosts` gap would be "noted in the
  documentation's withheld/gaps section"; `docs/mcp.md` §4 lists the 15 withheld operations but
  never mentions that a project's posts cannot be browsed. FR-027 is satisfied (the gap is
  recorded in `research.md`), so this is a one-line docs omission, not a defect.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-033) | 33 | 25 | 8 | 0 | 0 |
| Success criteria (SC-001…SC-009) | 9 | 5 | 4 | 0 | 0 |
| Constitution principles (I…VII) | 7 | 6 | 1 | 0 | 0 |

Partial FRs: FR-006 (F6), FR-008 (F4), FR-009 (F8, F9), FR-015 (F1, F7), FR-018 (F5),
FR-020 (F2, F3), FR-025 (F1), FR-028 (F1, F10).

Partial SCs: SC-001 (end-to-end with a real client is unrun — T056), SC-003 (F5),
SC-006 (F6), SC-009 (F1, F4).

Partial principle: VI (F12 — the dependency is justified in plan.md but has no decisions entry
of its own). I, II, III, IV, V and VII hold: the protocol facts were read from the installed
package rather than from memory; every claim except T056 is backed by a test that ran;
`src/server/mcp/**` holds no `ProjectScope` for a tool call and is in the import-boundary test;
`errorStatuses`/`codesForStatus` and the per-operation fixture table are each shared rather
than copied; no provider or scheduler code was touched; and the secret scan now covers a
listing, a call, and both with a tampered key.

Also checked, with nothing found: the 34 dispositions against the spec's lists (19 exposed =
7 reads + 4 compose + 8 setup; 15 withheld, with the three ambiguous-publish recovery
operations and all nine job operations among them — FR-019, FR-022, FR-023);
`PUBLISHED_TOOL_NAMES` against the derivation and against the 19 exposed ids (FR-004);
`dispositionProblems` rejects a missing disposition, an empty withheld reason, an empty
`confirm.effect`, and a `when` without a `whenDescription`, and also refuses to expose a
`permission: null` or multipart operation (FR-001, FR-003); the `error-surface.ts` extraction
is a verbatim move, so `openapi.test.ts` passing unedited is a real neutrality proof (T017);
the import-boundary additions (`src/server/mcp` in `pipeline`, `src/app/api/mcp` in `strict`);
the bridge builds its own `Request` and reaches no DAL or repository for a tool call (FR-011,
constitution III); no tool accepts a project identifier and no mechanism switches project
(FR-016); unknown arguments are refused by name rather than stripped (FR-005, the spec's
"invented project id" edge case); the confirmation check runs before any IO, so a refusal
costs no rate limit and writes nothing (FR-020); no v1 operation, request or response shape
changed, and no capability was added (FR-027); no database change, so `db:check` is
unaffected; `mkdocs.yml` nav and both cross-references landed with the page (FR-031, FR-032);
`docs/n8n.md` gained a trailing `## 11` with no heading renumbered; `docs/security.md` records
MCP as no new credential or trust boundary (FR-033); and the generate tool's description
carries the LLM-budget, auto-approve and validation-forces-review sentences (FR-026).

## What I could not check

- **The suite.** Per the constitution's "review: do not re-run the full suite", I read the
  Phase 7 commit's claim (`7120059`: "runs lint/typecheck/test/build/db:check clean,
  T049-T055") rather than re-running it, and there is no PR yet, so no CI run to read either.
  Every finding above is derived from the code; none depends on a test outcome. The one runtime
  probe I did run was Zod 4.6.5's `toJSONSchema` over the same shape `schema.ts` builds, to
  confirm F3's `required` array.
- **`docs/research/mcp.md` against the official MCP specification.** This phase cannot fetch
  the cited pages, so its **[spec]** citations are unverified here. I did verify the two
  protocol facts the findings rest on directly against the installed package
  (`server/index.js` registers `initialize` itself; `webStandardStreamableHttp` is the
  transport in use).
- **A real MCP client end to end (T056).** Still open and still correctly marked so: nobody has
  pointed a real client at `/api/mcp`, so SC-001's "in a single conversation" is argued from
  the in-process tests. F1, F3 and F4 are all defects a real client would surface immediately,
  which is an argument for doing T056 after the remediation rather than before.
- **The `Origin`-rejection choice.** `protocol.ts:17` refuses *any* `Origin` header, which is
  stricter than research's "403 for a disallowed origin" and is reasoned in a comment, but I
  cannot tell from here whether a browser-hosted MCP client anyone intends to use sends one.
  No test covers it.
- **Load and long-connection behaviour.** The accepted cost in the hosting decision (an MCP
  connection sharing the web container with the UI) is unmeasured; the transport is stateless
  per request, which makes it unlikely to matter, but nothing here measures it.
