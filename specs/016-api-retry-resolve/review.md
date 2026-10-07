# Review: Public API to retry, bulk-retry and resolve failed and ambiguous targets (016)

Reviewed 50 files changed across 13 commits, against `5223ee3` (merge-base with `origin/main`)...`HEAD` (`bf30aba`).

**Read in full (diff and surrounding code):**
- `src/server/api/operations/targets.ts`, `issues.ts`, `types.ts`, `posts.ts`, `index.ts`
- `src/server/api/errors.ts`, `idempotency.ts`, `openapi.ts`, and the request pipeline in `src/server/api/handle.ts` (unchanged, read for the no-key path)
- `src/server/dal/errors.ts`, `scope.ts`, `attempts.ts`
- `src/server/services/posts/locked.ts`, `retry.ts`, `index.ts` (`resolveAmbiguous`), `retry-all.ts` (unchanged, read as the bulk callee)
- `src/server/services/failures.ts` and `webhooks/emit.ts` (unchanged, read for emission)
- `src/server/db/schema/attempts.ts`, `posts.ts`, and `drizzle/0010_api_key_attribution.sql`
- `src/lib/api/schemas.ts`, `src/lib/failures/attempt-actor.ts` (+ test), `retry-all-text.ts` (+ test)
- both page edits
- all five new `tests/integration/api/endpoints/*` files, plus the diffs to `scope-enforcement`, `openapi`, `secret-scan`, `failures/attempts` and `docs/n8n-flow`
- the `docs/n8n.md`, `docs/failures.md`, `docs/decisions.md` and `README.md` diffs
- `spec.md`, `plan.md`, `tasks.md`, `contracts/http-api.md`, `contracts/services.md`, `data-model.md`, most of `research.md`, and the constitution

**Sampled:** `drizzle/meta/0010_snapshot.json` and `_journal.json`. These are generated; `pnpm db:check` reports "Migrations are current."

**Not reviewed:** `checklists/requirements.md` (a specify-phase artifact, no obligations) and `quickstart.md` (the test map; I checked the tests themselves instead).

**Executed in this phase:**
- **New and extended suites:** `pnpm vitest run` on the 5 new endpoint files, `scope-enforcement`, `openapi`, `failures/attempts` and `src/lib/failures`. 107 tests passed.
- **Cross-cutting suites:** `security/secret-scan`, `tests/lint` (including `api-imports`), `tests/integration/failures`, `tests/integration/docs` and `scope-check`. 291 passed.
- **012/015 suites (FR-003):** `posts/retry-resolve`, `posts/actions`, `posts/isolation`, `posts/lifecycle` and `scheduler/limits-retry`. 32 passed.
- **Checks:** `pnpm typecheck` and `pnpm db:check`, both green. The constitution asks review not to re-run typecheck, and I did, once.
- **Schema probe:** a throwaway Vitest probe in `$TMPDIR` (outside the repo) of `RetryTargetRequestSchema` and `ResolveTargetRequestSchema` through `zodDetails`.

## Verdict

The code holds together and meets the API contract. Every operation makes exactly one service call. The additive service changes (pairing `opts.postId`, `ConflictError.reason`, `actorRefs`/`attemptActor`/`resolverColumns`, and `self_commit`) are used the same way by every pass, with no duplicated helper and no drift between producer and consumer. The creator-deleted 500 (research F12) is fixed and has a regression test. Pairing returns 404 before any lock or write. Bulk runs outside a wrapper transaction. Every 409 carries the documented `details.reason`. Two obligations are only partly met, and both block the merge:

1. The n8n recovery recipe that FR-028 requires has no per-target retry limit. Followed as written, it retries a permanently failing post forever, because every new `post.failed` brings a new event id and therefore a new `Idempotency-Key`.
2. The tests that SC-003 and SC-005 rely on for webhooks cannot fail: no webhook endpoint is subscribed, and `emitEvent` writes nothing without one. The side-by-side parity checks also cover only one retry mode and one resolve outcome.

Both fixes are small: one docs edit and test-setup changes. I would fix them and merge. The MINOR items can go to a hardening entry.

## Findings

- [ ] MAJOR F1 — The n8n recovery recipe has no per-target retry limit, so it loops forever on a permanently failing post
      where:  docs/n8n.md:115-137 (steps 1–5; the key at docs/n8n.md:127), docs/decisions.md:613
      why:    FR-028 says the recipe "MUST include a per-target retry limit kept by the automation". US7 acceptance 1 says it "limits how many times the automation retries the same target". The Edge Case "Retry loop" says the recipe must make the automation keep its own limit, because Docket resets the attempt count on every retry. The recipe tells the automation to retry every `failed` target on every `post.failed`, with key `retry-{{event.id}}-{{targetId}}`. Take a post whose content the platform always rejects. It fails, the automation retries `now`, it fails again, and a new event id produces a new key. The retry is never deduplicated and never stops. `docs/decisions.md:613` (P14) says the recipe contains this limit, which is not true. T031's task text dropped the requirement, so T031 being ticked hides the gap.
      owed:   Add a step to `## 7. Recover failed posts` that keeps a per-target counter in the automation, for example n8n workflow static data keyed by `targetId`. It should stop retrying and alert a person after N tries (say 3), and say why Docket's own attempt count cannot be used. P14 then becomes accurate.
      traces: FR-028, US7-1, Edge Cases "Retry loop", SC-001

- [ ] MAJOR F2 — The webhook assertions for SC-003 and SC-005 can never fail, and the parity checks cover only one retry mode and one resolve outcome
      where:  tests/integration/api/endpoints/recovery-idempotency.test.ts:18-25 (and :61, :75, :103), tests/integration/api/endpoints/recovery-attribution.test.ts:137-138, :149, :163, src/server/services/webhooks/emit.ts:48-49
      why:    `emitEvent` returns early when no endpoint is subscribed (emit.ts:48-49). None of `postsEnv`, `failedTarget` or `outcomeTarget` subscribes one. So `observe().events` in the idempotency suite is always 0, and "no second webhook on replay" holds even if a replay emitted again. The parity test's `eventTypes` compares `[]` with `[]` in both cases. SC-003 says the at-most-one-webhook rule is checked "for every operation". SC-005 and FR-030 ask for "webhook emission parity", and SC-005 also asks for side-by-side checks "for each retry mode and resolve outcome". The only real emission test is `resolve-target.test.ts:34-43` (`post.published`). No test sees `post.failed` from an API action. Parity runs only for retry `now` (recovery-attribution.test.ts:143-144) and resolve `not_published`/`requeue:false` (:155-158). T023 and T025 are ticked as if all of this were covered.
      owed:   In both suites, subscribe a webhook endpoint to `post.published` and `post.failed` in the setup, for both the API env and the member env. Assert a non-zero expected event count where the status changes, for example resolve `published` → `post.published` and resolve `not_published`/`requeue:false` → `post.failed`, so the replay leg can fail. Extend the parity cases to retry `requeue` and `at` and to resolve `published` and `not_published`/`requeue:true`.
      traces: SC-003, SC-005, FR-025, FR-030

- [ ] MINOR F3 — A retry's `expected` is stored in the attempt summary in the caller's offset form, unlike the UI (UTC) and the API resolve path (normalised)
      where:  src/server/api/operations/targets.ts:169, src/server/services/posts/retry.ts:139, contrast src/server/api/operations/targets.ts:256
      why:    `retryPostTarget` passes `body` through unchanged, and `requeueTarget` writes `requestSummary.expected` verbatim. With `expected: "2026-10-05T11:00:00+02:00"`, the attempt log stores and shows the offset string. The UI passes `preview.scheduledAt` (`…Z`, RetryDialog.tsx:101). FR-018 says the request summary must be identical to the UI's. The resolve pass normalised its `expected` (targets.ts:256) but the retry pass did not, so the two operations follow different conventions. `changedFromPreview` is unaffected, because it compares instants.
      owed:   Normalise retry `expected` to UTC in the operation, the same way as resolve.
      traces: FR-018

- [ ] MINOR F4 — No test exercises the recovery operations without an `Idempotency-Key` (US5-4)
      where:  tests/integration/api/endpoints/retry-target.test.ts:18, src/server/api/handle.ts:159-162
      why:    Every recovery test sends `idem`. The no-key path (`execute`) runs only in `scope-enforcement.test.ts`, which asserts "not 401/403" and never 200. Nothing checks US5-4: a second keyless retry gets `409 not_failed`. The code path is simple, but it is the default for a caller that omits the header.
      owed:   Add a keyless double-retry test: first `200`, second `409` with `details.reason: "not_failed"`.
      traces: US5-4, FR-030

- [ ] MINOR F5 — The secret scan does not look for the key's `last4` in the attempt-log page, although T030 says it does
      where:  tests/integration/security/secret-scan.test.ts:290-296
      why:    FR-026 says the key's last four characters MUST NOT appear in the attempt log view. The scan's `oneTime` list has the write key, its hash and the idempotency key, but not `last4`. The code is safe: `toAttemptViews` reads only `.name` (src/server/services/failures.ts:104). But the ticked T030 claims coverage the test does not have.
      owed:   Assert that the rendered Failures-page piece does not contain the write key's `last4`. Scope it to that page to avoid four-character false positives elsewhere.
      traces: FR-026, SC-007

- [ ] MINOR F6 — No test checks the recovery recipe's requests against the OpenAPI document
      where:  tests/integration/docs/n8n-flow.test.ts:42
      why:    The doc-flow test was cut off before `## 7. Recover failed posts` so that the generate-and-queue run still passes. No test replaced that coverage. US7's Independent Test asks that every request, header and field the recipe names exists in the OpenAPI document. I checked by hand that the path, the `Idempotency-Key` header and `mode` all exist (targets.ts:80, :89, :167).
      owed:   Add a small test that parses the section-7 `http` blocks and matches their method, path template and body keys against `buildOpenApiDocument()`.
      traces: US7 Independent Test, FR-028

- [ ] MINOR F7 — Docs and comments say things the code does not do
      where:  src/server/api/operations/targets.ts:85, docs/n8n.md:132, docs/decisions.md:601, src/lib/api/schemas.ts:241, src/server/api/operations/types.ts:20-21
      why:    (a) The `retryPostTarget` description says "A refusal is reported in a 200 response with `status: failed`". Under D3, refusals are `409`, and the `200` cases are typed outcomes. docs/n8n.md:132 also calls `no_active_slots` "a refusal". An automation builder may then expect blocked-account refusals in a 200. (b) decisions.md:601 (P2) says resolve is "a discriminated union nested on `outcome` then `requeue`", but schemas.ts:241 is a plain `z.union`. The behaviour still holds: the probe reports a bad `url` at path `url`. (c) In types.ts:20-21 the comment "The single list the router, OpenAPI document and tests use" now sits above `ApiExamples`, with nothing it describes.
      owed:   Reword (a) as "a typed outcome such as `in_past` …". Make (b) say `z.union`. Move or delete (c).
      traces: FR-027, FR-029, D3

- NOTE F8 — A resolve body with `outcome: "not_published"` and no `requeue` is rejected with one detail at `path: ""` and "Invalid input" (probe output). This is because `ResolveTargetRequestSchema` is a plain union (src/lib/api/schemas.ts:241). It satisfies FR-009, which asks only for a 400 and `url`-specific reporting, but an automation builder gets no hint that `requeue` is missing. Nested discriminated unions, as P2 planned, would name the field.

- NOTE F9 — On the Failures page, grouped runs (`run.count > 1`) show no "Who" at all (src/app/p/[projectSlug]/failures/page.tsx:103-118). This predates 016 and shows no wrong actor, so SC-004 holds. But consecutive identical entries from an automation, for example repeated `retry_requested`/`no_free_slot` from a looping recipe (F1), collapse into one row without the key's name.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-030) | 30 | 27 | 3 (FR-018 F3, FR-028 F1, FR-030 F2/F4/F6) | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 6 | 2 (SC-003, SC-005: F2) | 0 | 0 |
| User stories (US1–US7) | 7 | 6 | 1 (US7: F1) | 0 | 0 |
| Spec decisions (D1–D10) | 10 | 10 | 0 | 0 | 0 |
| Plan decisions (P1–P15) | 15 | 14 | 1 (P14: F1) | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |

Notes on the satisfied counts, by review category the constitution asks for:

- **Concurrency and locking:** the API path takes the UI's lock order (`withLockedTarget` locks the post, then its targets). Pairing is checked on an id that never changes, before `lockPost` (locked.ts:38-39). In default mode the stored-answer `UPDATE` comes after the post lock, the same order as the other idempotent operations. The two-key race test passes (retry-target.test.ts:174-180). Bulk keeps per-target transactions (`self_commit`, idempotency.ts:152; handle.ts:99 for the no-key path).
- **Idempotency:** replay of 200 and 409, key reuse 422, in-progress 409 with `Retry-After`, and bulk replay then continuing with a new key are all tested and pass. Only the webhook leg is vacuous (F2).
- **Authorization and project scoping:** `write_posts` gives 403 naming the permission. Foreign ids give the same 404 as unknown ones for both path params (generic scope test). A foreign `accountId` gives an identical "nothing to retry" 200. Composite FKs pin key references to the project. `api-imports` lint is green.
- **Time zones and DST:** `at` and `expected` require an offset, `scheduledAtLocal` comes from `plannedTime`, and resolve `expected` is normalised. See F3 for retry.
- **Error and ambiguous paths:** no documented outcome gives a 5xx. Creator-deleted is fixed (recovery-attribution.test.ts:84-98). Ambiguous targets are refused by retry (`409 not_failed`) and never retried by the recipe.
- **Secrets:** the view reads only the key name. The secret scan covers responses, `publish_attempts` rows and the Failures page (F5 is the one gap).

## What I could not check

- **SC-008 timing.** The bulk API was not timed. The 101-target cap tests ran in `now` mode only. 015's 2.0–2.7 s figure for 100 requeues is inherited, not re-measured through the API.
- **The real n8n flow, a running `pnpm dev`, and curl.** The quickstart's manual walk-through was not run, and no webhook was delivered over HTTP to a real receiver.
- **Browser rendering.** I did not see the "API key {name}" label in a browser. It was checked through the server-rendered Failures page in the secret scan and through `toAttemptViews` / `attemptActorLabel` unit and integration tests.
- **CI on a pull request.** No PR exists from this phase. The full `pnpm lint`, `pnpm test` and `pnpm build` were not re-run here (constitution review rule). I rely on implement's ticked final pass, T034, whose output I did not see.
- **Neon / pooled transaction mode.** The FK additions and savepoint nesting were exercised only against the local test Postgres.
