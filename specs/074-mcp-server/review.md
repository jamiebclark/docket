# Review: An MCP server over the v1 API (074) — re-review after Phase 8 remediation

Second review of this entry. The first review (commit `2696e94`, which also carried the
remediation) found 0 BLOCKER and 6 MAJOR; Phase 8 (T057–T062) closed all six. Per the
constitution's "review is exhaustive once, then scoped", this pass checks **only** that each
earlier finding is fixed and that the files the remediation touched introduced no regression.
It deliberately opens no new lines of inquiry, and everything it noticed anyway is recorded
as MINOR for a hardening entry rather than as a blocker.

Reviewed the remediation diff (`git show 2696e94`): 13 files, 516 insertions. Read in full,
at their current state: `src/server/mcp/{protocol,bridge,schema,describe}.ts`,
`src/server/api/operations/generate.ts`, `src/server/api/error-surface.ts`,
`src/server/api/operations/slots.ts`, `docs/mcp.md`,
`tests/integration/api/{mcp-tools,mcp-protocol}.test.ts`,
`tests/unit/mcp/{describe,schema}.test.ts`, `tests/helpers/{mcp,mcp-bridge,api}.ts`.
Also read, to settle specific claims: `src/server/api/handle.ts` (the `Retry-After` source),
`src/server/api/idempotency.ts` (the `Idempotent-Replayed` source),
`src/server/services/generation/policy.ts` (policy resolution, the subject of F2),
`src/server/dal/projects.ts` (`ProjectSettingsPatch`, used by the new F2 test),
`src/server/db/schema/projects.ts` (the policy defaults the test restores),
`src/server/api/operations/errors-doc.ts` (`standardErrors`, the subject of F6),
`src/server/mcp/dispositions.ts`, `.specify/memory/constitution.md`, `spec.md`, `plan.md`,
`tasks.md`, `contracts/mcp-tools.md`, `contracts/mcp-transport.md`, and the 074 entry in
`docs/decisions.md`.

Not re-reviewed, because the remediation did not touch them and the first review swept them:
the 34 dispositions, `naming.ts`, `types.ts`, the route module, `api-fixtures.ts`,
`api-imports.test.ts`, `mkdocs.yml`, `docs/{n8n,security}.md`. Still not reviewed for factual
accuracy against the published MCP specification: `docs/research/mcp.md` (this phase cannot
fetch the cited pages).

**Targeted runs** (the constitution bars a re-review from re-running the full suite, and
permits probes that prove or disprove a finding — these prove the six fixes):

| Command | Result |
|---|---|
| `vitest run tests/unit/mcp/` | 4 files, 14 tests passed — proves F3, F6 |
| `vitest run tests/integration/api/mcp-{tools,protocol,surface}.test.ts` | 3 files, 28 tests passed — proves F1, F2, F4, F5 |
| `vitest run tests/integration/security/secret-scan.test.ts tests/integration/api/{openapi,scope-enforcement}.test.ts` | 3 files, 25 tests passed — regression guard on the remediated response path |

67 tests across 7 files, all green, against the real Postgres on port 5555.

## Verdict

**The remediation holds. Nothing blocks the merge.** All six MAJORs are genuinely closed, not
just ticked: the protocol layer now folds the pipeline's `Retry-After` and
`Idempotent-Replayed` into the tool result and a protocol-level test proves it (F1); the
generate gate fires on the *resolved* effect rather than the requested policy, with a test
against a project configured `auto_approve` + `add_to_queue` (F2); `confirm` is
optional-but-still-`literal(true)` in a conditional tool's published schema, with the
`required` array asserted both ways (F3); the bridge forwards `x-api-key` (F4); the isolation
test now covers all six resource-param types the nineteen tools take and throws rather than
skipping on a seventh (F5); and the failure list unions each operation's own documented
`>= 400` responses, so `docket_create_project` names `conflict` and `docket_get_post` names
`not_found` (F6). I checked F5's completeness directly: the exposed tools' `resourceParams`
are exactly `{postId, targetId, mediaId, accountId, profileId, slotId}`, so the new `throw`
cannot fire spuriously, and `jobId`/`itemId` belong only to withheld operations.

What the remediation left behind is a **documentation lag, not a defect**: the F2 fix changed
what the generate gate does, and three of the four places that publish that predicate were
not updated with it. `docs/decisions.md:3347` still tells a future reader "a plain
generate-to-draft call needs no confirmation", which the code no longer does (F17), and the
`whenDescription` the remediation carefully rewrote is a field nothing renders — so the
escape hatch it describes (`schedulingPolicy: "leave_as_draft"`) reaches a human reading
`docs/mcp.md` but never reaches the model reading the tool description (F16). That is the one
thing worth fixing soon, because F16 is the residue of F3's original concern: a model told
flatly "Requires `confirm: true` to proceed" and shown an optional `confirm` will pass
`confirm: true` by reflex. It is safe — passing the confirmation is the *conservative* answer
and nothing publishes without the API's own `confirmUnreviewedQueue` guard as well — but it
makes the gate carry less signal than it should.

Six MINORs carried forward from the first review and five new ones are listed below. None would corrupt
data, leak a secret, or cross a project boundary. The single genuinely unverified thing is
unchanged from the first review: T056, the manual pass with a real MCP client, which no
automated test can replace and which is correctly still unchecked in `tasks.md`.

## Remediation of the first review's findings

Checked means verified fixed at the location given, by reading the code and by the named test
actually running green in this pass.

- [x] MAJOR F1 — **Closed.** `bodyWithHeaders` (src/server/mcp/protocol.ts:51-62) folds
      `Retry-After` into `error.retryAfterSeconds` and `Idempotent-Replayed` into a top-level
      `alreadyReplayed: true`, and `tools/call` serialises that instead of the raw body
      (src/server/mcp/protocol.ts:81). Proven at the wire, not the bridge, by
      tests/integration/api/mcp-protocol.test.ts:85 (a key with `rateLimitPerMinute: 1`, second
      call asserts `error.retryAfterSeconds >= 1`) and :94 (a replayed `docket_create_post`
      asserts `alreadyReplayed`). The wait cannot be zero: `retryAfterSeconds` in
      src/server/api/handle.ts:87 clamps to `[1, 60]`. Broader than the `contracts/mcp-tools.md`
      wording, which promised the wait only for `rate_limited` — the implementation also
      surfaces it for the 409 in-flight idempotency conflict (src/server/api/idempotency.ts:89)
      and `generation_unavailable`. More information, correctly sourced; no objection.

- [x] MAJOR F2 — **Closed.** The predicate is now
      `(args) => args.schedulingPolicy !== "leave_as_draft"`
      (src/server/api/operations/generate.ts:70), so an absent policy — the case that fell
      through to `scope.project.defaultSchedulingPolicy` in
      src/server/services/generation/policy.ts:50 — demands confirmation. I confirmed the hole
      was real and is now shut: `resolvePolicies` skips its `auto_approve` grant check entirely
      when the project *default* is `auto_approve` (policy.ts:51-57), so the key need not even
      hold `auto_approve` to reach `decidePolicy`'s queue branch (policy.ts:34). The new test
      at tests/integration/api/mcp-tools.test.ts:215 sets the project to
      `auto_approve` + `add_to_queue` via `updateProject`, asserts `confirmation_required` for a
      plain call, and restores `review_required` + `leave_as_draft` in a `finally` — which match
      the column defaults in src/server/db/schema/projects.ts:19,22, so the shared world fixture
      is left as it was found.

- [x] MAJOR F3 — **Closed.** src/server/mcp/schema.ts:36 is now
      `confirm.when ? z.literal(true).optional() : z.literal(true)`, so a conditional tool's
      published schema permits the plain call while still rejecting any non-`true` value, and
      the four unconditional tools keep `confirm` required. tests/unit/mcp/schema.test.ts:23
      asserts the `required` array both ways — the gap the first review named (only property
      *names* were compared) is now covered.

- [x] MAJOR F4 — **Closed.** src/server/mcp/bridge.ts:83-84 copies `x-api-key` alongside
      `authorization`, so the credential `readKey` accepted at the shape check
      (src/server/api/auth.ts:10) is the one `handleApiRequest` receives. Covered by
      tests/integration/api/mcp-tools.test.ts:105 through the new `keyHeader` option in
      tests/helpers/mcp-bridge.ts:35-38. A key sent both ways with different values is still
      `readKey`'s `"conflict"` and refused (bridge.ts:44).

- [x] MAJOR F5 — **Closed and now unskippable.** `foreign` carries `profileId` and `slotId`
      (tests/integration/api/mcp-tools.test.ts:122-123) and the silent `continue` became
      `throw new Error(...)` (:129). I verified the map is exhaustive rather than merely larger:
      grepping `resourceParams` across `src/server/api/operations/` shows the nineteen exposed
      operations take exactly `postId`, `targetId`, `mediaId`, `accountId`, `profileId` and
      `slotId`; `jobId`/`itemId` appear only on withheld job operations. So the `throw` cannot
      fire today and will fire the moment a new exposed operation adds a seventh.

- [x] MAJOR F6 — **Closed.** src/server/mcp/describe.ts:16-19 unions `errorStatuses(op)` with
      the `>= 400` keys of `op.responses` before mapping to codes, which is the right shape of
      fix: `error-surface.ts:19` deletes the documented statuses on purpose, because
      `openapi.ts` emits those separately. tests/unit/mcp/describe.test.ts:30 asserts `conflict`
      for `createProject` and `not_found` for `getPost` — the two examples the finding named —
      so the test no longer confirms the implementation against itself. `listActivity`, the
      third example, documents 400/401/403 inline (src/server/api/operations/activity.ts:80-98)
      and so is covered by the same union.

## Findings

0 BLOCKER, 0 MAJOR. Eleven MINORs and four notes. Per the constitution's re-review rule, the
five findings this pass noticed for the first time (F16–F20) are MINOR by construction, not by
judgement of their size — they are recorded for a hardening entry, and none of them blocks.

### New in this pass

- [ ] MINOR F16 — `confirm.whenDescription` is written by three artifacts and rendered by none, so the escape hatch the F2 fix created never reaches the model.
      where:  src/server/mcp/describe.ts:24, src/server/api/operations/generate.ts:70-72
      why:    `describeTool` emits only `confirm.effect` — "Requires `confirm: true` to
              proceed: Generate a post from the brief, then queue it to publish on each target
              account's next free slot." Nothing in `src/` reads `whenDescription`; grepping it
              finds only the field's declaration (operations/types.ts:31) and
              `dispositionProblems`' check that it is non-empty when `when` is set
              (src/server/mcp/dispositions.ts:41-45). T058 duly rewrote the string, and
              `docs/mcp.md:29` publishes it for a human — but the model choosing the tool is
              told the effect is a live publish and is not told that
              `schedulingPolicy: "leave_as_draft"` is the way to generate a draft without
              confirming. Combined with F3's (correct) fix making `confirm` optional, the
              likely model behaviour is to send `confirm: true` on every generate call, which
              is the no-op the first review warned about. Two secondary inaccuracies follow
              from the same omission: the effect sentence describes queueing even for a
              project whose default is `leave_as_draft` (where `confirm: true` queues
              nothing), and the generate tool is the only one whose confirmation is
              conditional, so a reader of the description cannot tell it apart from the four
              unconditional ones.
      owed:   Append `confirm.whenDescription` to the confirmation sentence in `describeTool`
              when it is present, and extend tests/unit/mcp/describe.test.ts to assert that a
              conditional tool's description names the condition. (`dispositionProblems`
              already guarantees the string exists whenever `when` does, so there is no new
              invariant to enforce.)
      traces: FR-006, FR-020, SC-006

- [ ] MINOR F17 — Three published descriptions of the generate confirmation still state the predicate the F2 fix replaced, including the decisions log.
      where:  docs/decisions.md:3347, specs/074-mcp-server/data-model.md:74, specs/074-mcp-server/contracts/mcp-tools.md:90
      why:    All three say confirmation is required when `schedulingPolicy` is "present and
              not `leave_as_draft`", and `docs/decisions.md:3348` draws the conclusion "so a
              plain generate-to-draft call needs no confirmation (matching the spec's text)".
              After T058 the code demands confirmation for a plain call, so the live judgement
              log — the artifact the constitution points a future reader at, and the one
              FR-030 names — now describes behaviour the code does not have, and states the
              opposite of `docs/mcp.md:29`. The remediation updated `docs/mcp.md` and the
              `whenDescription` and stopped there. (`research.md:261` says the same thing but
              is a Phase 0 record of what was decided then, so it is history rather than a
              stale claim.)
      owed:   Update the 074 entry's "One open judgement" paragraph to the predicate that
              shipped and to its real consequence — confirmation unless the caller explicitly
              asks for a draft — and the same one-line correction in `data-model.md` §2 and
              `contracts/mcp-tools.md`'s confirmation table.
      traces: FR-030

- [ ] MINOR F18 — `docs/mcp.md` still introduces the surface as "four tools demand an explicit `confirm: true`", which the F2 fix made misleading.
      where:  docs/mcp.md:17, docs/mcp.md:29
      why:    Line 17 is read before the table, and after T058 a fifth tool demands
              confirmation on every call that does not explicitly pass
              `schedulingPolicy: "leave_as_draft"` — i.e. on the default call an operator will
              actually make. The generate row at line 29 is accurate, but a reader who stops at
              line 17 (or who counts the **yes** markers) will not expect their first generate
              call to be refused. Line 17's remaining sentence, about `false`/`"true"`/`1`
              being refused, is correct for all five.
      owed:   Reword line 17 to "four tools always demand it, and `docket_generate_post`
              demands it unless the call explicitly asks for a draft", so the count and the
              table agree.
      traces: FR-031

- [ ] MINOR F19 — The two fields the F1 fix synthesises into the tool result are documented nowhere, so a client author cannot find the wait or the replay marker.
      where:  src/server/mcp/protocol.ts:56, src/server/mcp/protocol.ts:59, docs/mcp.md:41, docs/mcp.md:66
      why:    `error.retryAfterSeconds` and the top-level `alreadyReplayed: true` are the only
              two places an MCP response differs from the HTTP response for the same call, and
              they exist precisely because a `CallToolResult` has no header channel. But
              `docs/mcp.md:66` still describes a failure as carrying "the same code, human
              message and request id the public API would give" and says only that a
              rate-limited call "reports the wait" without saying where, and `docs/mcp.md:41`
              describes a replay as returning "the first result" with no mention of the marker.
              `contracts/mcp-transport.md:113` and `contracts/mcp-tools.md:68` describe the
              intent but not the field names. The consequence is small and entirely
              documentation-shaped — the behaviour is right and tested — but the one audience
              the page exists for cannot act on it.
      owed:   Name both fields in `docs/mcp.md` §3 (the idempotency paragraph) and §6 (errors),
              as the MCP translation of the two HTTP response headers.
      traces: FR-025, FR-028, FR-031, SC-009

- [ ] MINOR F20 — `bodyWithHeaders` spreads the response body into an object literal, which would silently corrupt an array-shaped body.
      where:  src/server/mcp/protocol.ts:59
      why:    `body = { ...body, alreadyReplayed: true }` on an array yields
              `{"0": …, "1": …, alreadyReplayed: true}` — a different type, not an annotated
              one. It is harmless today, and I checked rather than assumed: every exposed
              idempotent operation returns a JSON object at the top level (`createPost`,
              `queuePost`/`schedulePost` return `{results}`, `addWeekSlots` returns
              `{added, alreadySet}`, `createProject`/`addSlot`/`updateSlot` return a single
              entity, the voice operations return `{id, version, isDefault}`). So this is a
              latent trap for a future operation rather than a live bug, and it is the kind of
              thing that fails as a wrong shape rather than as an error.
      owed:   Guard with `!Array.isArray(body)`, or carry the marker in a sibling field of the
              result rather than inside the operation's body. Worth one line while the reason
              is still fresh.
      traces: FR-027

### Carried forward from the first review, re-confirmed still open

Each was MINOR then and is MINOR now; I re-read each location to confirm the remediation did
not incidentally fix or worsen it. Full reasoning is in the first review's text, preserved in
`git show 2696e94:specs/074-mcp-server/review.md`.

- [ ] MINOR F7 — `tools/list` counts against the key's rate limit but is never refused when the key is over it.
      where:  src/server/mcp/protocol.ts:72
      why:    The handler still destructures only `{ scope }` from `authenticate`, so
              `forApiKey`'s `rate` is discarded and nothing compares `rate.count` with
              `rate.limit` the way src/server/api/handle.ts:138 does. Line number moved from
              :54 to :72 with the F1 insertion; the code is unchanged.
      owed:   Refuse the listing with the same `rate_limited` message and wait when
              `rate.count > rate.limit`.
      traces: FR-015

- [ ] MINOR F8 — `initialize` is served with no key, contrary to FR-009 and `contracts/mcp-transport.md` §9.
      where:  src/server/mcp/protocol.ts:68
      why:    `newServer()` still registers handlers for `tools/list` and `tools/call` only;
              the SDK answers `initialize` itself and authenticates nothing. The handshake
              discloses only the server name, version and capabilities, and the transport is
              stateless, so no session is created — but it is an unmetered, unauthenticated
              endpoint and the contract says otherwise.
      owed:   Authenticate in `handleMcpRequest` before `transport.handleRequest`, or amend
              the contract and FR-009's reading to exclude the handshake, with the reason.
      traces: FR-009

- [ ] MINOR F9 — A refused `tools/list` carries no `invalid_api_key` code, only the JSON-RPC code.
      where:  src/server/mcp/protocol.ts:37
      why:    Still `throw new McpError(ErrorCode.InvalidRequest, "Invalid API key.")` with no
              `data`, so a client cannot branch on a stable code; and
              tests/integration/api/mcp-protocol.test.ts:37 still asserts only that *an* error
              came back.
      owed:   Attach the API error body as the `McpError`'s `data` and assert the
              `invalid_api_key` code in the protocol test.
      traces: FR-009, FR-028

- [ ] MINOR F10 — Bridge-level refusals carry an empty `requestId`.
      where:  src/server/mcp/bridge.ts:26
      why:    `outcomeFor` still calls `errorBody(e, "")`, so the three refusals the bridge
              answers itself — `invalid_api_key`, `validation_failed` for an unknown argument,
              and `confirmation_required` — return `error.requestId: ""` where the equivalent
              HTTP call always carries a uuid. More visible after F2 than before, because a
              plain generate call is now one of those refusals.
      owed:   Mint a request id in `callTool` (or accept one) and pass it to `errorBody`.
      traces: FR-028, SC-009

- [ ] MINOR F11 — `WITHHELD` is exported and used nowhere; the 15 published reasons are a hand copy no test ties to the field.
      where:  src/server/mcp/dispositions.ts:8, docs/mcp.md:49
      why:    Re-grepped `src/`, `tests/` and `scripts/`: the only occurrence is the
              declaration. `docs/mcp.md`'s withheld table remains a manual transcription of
              the `reason` strings, so editing a reason in the operation table leaves the
              published list stale with nothing failing — and the export that exists to
              prevent exactly that is the dead end.
      owed:   Drive a test (or the page) from `WITHHELD`, or delete the export and say in the
              code that the documentation is the published copy.
      traces: FR-024, SC-008

- [ ] MINOR F12 — The new runtime dependency has no decision entry of its own in `docs/decisions.md`.
      where:  docs/decisions.md:3333
      why:    Constitution VI requires both a justification in plan.md and an entry in
              `docs/decisions.md` for any new runtime dependency. The justification is in
              plan.md's Complexity Tracking, and the 074 entry names
              `@modelcontextprotocol/sdk` in its implementation-outcome paragraph, but it gets
              none of the accepted-cost / reversal treatment the entry's other two decisions
              get.
      owed:   Add a third bullet to the 074 entry: why the SDK rather than a hand-rolled
              JSON-RPC endpoint, the accepted cost, and how to reverse it (the fallback is
              already written in plan.md's Complexity Tracking).
      traces: Constitution VI, FR-030

### Notes

- NOTE F21 — **The generate gate is now stricter than the spec's Decisions text, and that is
  the right trade.** The spec says "Generation is exposed without confirmation"; after T058 a
  generate call needs either `schedulingPolicy: "leave_as_draft"` or `confirm: true`. This is
  what the first review's F2 *owed* asked for ("treat an absent `schedulingPolicy` as
  'unknown, therefore confirm'"), it errs toward refusing rather than publishing, and the
  alternative — resolving the project's default inside the `when` predicate — would have put a
  database read into a function the bridge calls before building any request. Recorded so a
  human merging knows the deviation is deliberate and ruled on twice (first review's F13, and
  here). US1 acceptance 3 still holds, with one extra argument in the call.

- NOTE F22 — The first review's F14 observation is unchanged and still worth knowing: the
  write-tool half of the equivalence proof (tests/integration/api/mcp-tools.test.ts:93-101)
  sends the HTTP call and the MCP call with the *same* `Idempotency-Key`, so the MCP answer is
  `runIdempotent`'s replay of the HTTP one rather than an independent execution. It is a real
  proof that the bridge built the same method, route and canonical body — a mismatch would be
  422 `idempotency_key_reused` — but it is not two executions compared. The seven reads are
  compared independently.

- NOTE F23 — First review's F15, unchanged: research D15 said the missing `listPosts` gap
  would be noted in the documentation's withheld/gaps section; `docs/mcp.md` §4 lists the 15
  withheld operations but never mentions that a project's posts cannot be browsed. FR-027 is
  satisfied (the gap is recorded in `research.md`), so this is a one-line docs omission.

- NOTE F24 — The implementation is broader than `contracts/mcp-tools.md:68-78` in two harmless
  ways, both from the F1 fix: the wait is surfaced for any error carrying `Retry-After` rather
  than only `rate_limited`, and `structuredContent` (which the contract hedged as "where the
  SDK carries it") is not emitted. Neither is a defect; recorded so the next reader of the
  contract is not surprised.

## Coverage

The first review swept all 33 FRs, 9 SCs and 7 constitution principles. This pass re-checked
the 8 FRs and 4 SCs the first review marked partial, plus every obligation the remediated
files touch; the rest are carried forward from that sweep unchanged.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-033) | 33 | 27 | 6 | 0 | 0 |
| Success criteria (SC-001…SC-009) | 9 | 8 | 1 | 0 | 0 |
| Constitution principles (I…VII) | 7 | 6 | 1 | 0 | 0 |

**Moved to satisfied by the remediation**: FR-008 (F4), FR-018 (F5), FR-020 (F2+F3),
FR-021 (F2), FR-025 (F1 — the replay marker now reaches the client), SC-003 (F5),
SC-006 (F6), SC-009 (F1+F4).

**Still partial, with the finding that holds them there**: FR-006 (F16 — the confirmation
sentence does not name the condition), FR-009 (F8, F9), FR-015 (F7 — the listing counts
against the limit but is not refused by it; F1's half is closed), FR-028 (F10), FR-030 (F17 —
the decisions entry describes a predicate the code no longer has; F12), FR-031 (F18, F19).

**Still partial SC**: SC-001 — "in a single conversation with an LLM client" is argued from
in-process tests only; T056 is the manual pass and remains unchecked.

**Still partial principle**: VI (F12 — the dependency is justified in plan.md but has no
decisions entry of its own). I, II, III, IV, V and VII hold, and the remediation did not
weaken any of them: the only protocol facts it relied on (`Retry-After` and
`Idempotent-Replayed` have no header channel in a `CallToolResult`) come from the SDK's own
types rather than memory (I); every claim above except T056 is backed by a test I watched run
(II); the remediation added no scope, no repository access and no project identifier, and the
isolation test it strengthened is the one that proves it (III); it added no second
implementation of anything — the failure-list fix *removed* the divergence by unioning the
operation's own responses into the shared derivation (IV); no provider or scheduler code was
touched (V); and the secret scan over the MCP path, including the two new synthesised fields,
is green (VII).

**Re-checked with nothing found**: the `error-surface.ts` extraction is still neutral
(`openapi.test.ts` green unedited); HTTP scope enforcement is unaffected by the shared fixture
table (`scope-enforcement.test.ts` green); the drift test still binds the derived surface to
the table in both directions after the disposition change (`mcp-surface.test.ts` green); the
19 published tool names are unchanged by the remediation, so no client's saved instructions
break (FR-004); the `confirm` argument is still excluded from the request body the bridge
builds, because `argumentNamesFor` reads only the operation's own schemas
(src/server/mcp/schema.ts:21-27); and the new F2 test restores the project's policy defaults in
a `finally`, so it cannot leak state into the rest of the file.

## What I could not check

- **The full suite, lint, typecheck and build.** The constitution bars a re-review from
  re-running them. The remediation commit `2696e94` does not itself claim a gate run — unlike
  Phase 7's `7120059`, which claims "lint/typecheck/test/build/db:check clean" — and there is
  still no PR, so there is no CI run to read. I ran the seven test files the remediation
  touches or endangers (67 tests, all green) and verified by reading that every type the new
  test code uses exists with the signature it assumes: `updateProject(projectId, patch)` and
  `ProjectSettingsPatch`'s five required fields (src/server/dal/projects.ts:107-126),
  `createKey`'s `rateLimitPerMinute` option (tests/helpers/api.ts:17-21). **A full
  `pnpm lint && pnpm typecheck && pnpm test && pnpm build` has not been run on this code**;
  that is the one thing a human should confirm, and CI on the PR will do it.
- **A real MCP client end to end (T056).** Unchanged from the first review: nobody has pointed
  a real client at `/api/mcp`. F1, F3 and F4 were all defects a real client would have
  surfaced immediately, which is an argument for doing T056 now that they are fixed.
- **`docs/research/mcp.md` against the official MCP specification.** This phase cannot fetch
  the cited pages. The two protocol facts this review rests on were verified against the
  installed package rather than the specification text.
- **The `Origin`-rejection choice** (src/server/mcp/protocol.ts:17 refuses *any* `Origin`
  header). Unchanged and still uncovered by a test; I cannot tell from here whether a
  browser-hosted client anyone intends to use sends one.
- **Load and long-connection behaviour.** The hosting decision's accepted cost (an MCP
  connection sharing the web container with the UI) is still unmeasured.
