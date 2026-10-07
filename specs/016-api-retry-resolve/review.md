# Review: Public API to retry, bulk-retry and resolve failed and ambiguous targets (016)

**Re-review after remediation.** The constitution sets the scope ("Review is exhaustive once, then scoped"). This pass checks only two things: that each earlier blocking finding is fixed, and that the files the remediation changed introduced no regression. Anything new is recorded as MINOR at most.

The feature as a whole is 51 files changed across 15 commits, against `5223ee3` (merge-base with `origin/main`)...`HEAD` (`b06628e`). The first review covered `5223ee3...bf30aba` in full; see that review's coverage in git (`d16681b`). The remediation is one commit, `b06628e`, which touches 4 files.

**Read in full (remediation diff and the code it depends on):**
- `docs/n8n.md` §7 (lines 115–139), and `docs/decisions.md:613` (P14), to check it is now accurate
- `tests/integration/api/endpoints/recovery-idempotency.test.ts` (whole file)
- `tests/integration/api/endpoints/recovery-attribution.test.ts` (setup, plus the whole parity `describe` at :130–194)
- `specs/016-api-retry-resolve/tasks.md` Phase 11 (T036–T037)
- the code that decides whether the new assertions can fail: `src/server/services/webhooks/emit.ts:43-49` (the subscriber gate), `src/server/services/posts/status.ts:9-37` (derived status and when it emits), the attempt summary shapes at `src/server/services/posts/retry.ts:125,139,166`, `tests/helpers/failures.ts` and `tests/helpers/retry.ts` (fixtures and `LATER`), `src/server/services/webhooks/endpoints.ts:76-91` (`createEndpoint`)
- the matching spec text: FR-028, FR-030, SC-003, SC-005, US7, and the Edge Case "Retry loop"

**Not re-read:** the 47 files the remediation did not touch. `git diff b06628e~1 b06628e --stat -- src` is empty, so no source changed after the first review, and its judgement of those files stands.

**Executed in this phase:** `pnpm vitest run` on the two remediated test files. 2 files and 23 tests passed in 7.4 s. Under the constitution's review rule I did not re-run lint, typecheck, build or the full suite.

## Verdict

Both blocking findings are fixed, and the remediation introduced no regression. The feature meets its spec and is ready for a human to merge. F1: the n8n recipe now tells the automation to keep a per-target counter, stop after N tries and alert a person. It also explains why Docket's attempt count cannot do that job. This satisfies FR-028 and US7-1, and P14 is now accurate. F2: both suites now subscribe a webhook endpoint, so `emitEvent` actually writes events. The idempotency suite proves this with a passing non-zero assertion (`emits: 1` for resolve `published`). The parity suite now covers all three retry modes and all three resolve outcomes. The earlier review expected `post.failed` from resolve `not_published`/`requeue:false`, and that expectation was wrong (NOTE F12). The implementer asserted zero events there, which is correct. The earlier MINOR items F3–F7 are unchanged and still open; they suit a hardening entry. This pass adds one MINOR (F10) on the recipe's bulk step.

## Findings

- [x] MAJOR F1 — **Resolved.** The n8n recovery recipe had no per-target retry limit, so it looped forever on a permanently failing post
      where:  docs/n8n.md:134 (new "Cap the retries" paragraph under step 3), docs/decisions.md:613
      why:    (original) FR-028 requires "a per-target retry limit kept by the automation", and the recipe had none.
      check:  docs/n8n.md:134 now says to "Keep your own counter per `targetId` (for example in n8n workflow static data), stop after N tries (say 3) and alert a person". It explains that Docket's attempt count "resets on every retry, and each `post.failed` event has a new event id, so every retry gets a new `Idempotency-Key`". This matches the Edge Case "Retry loop" (spec.md:176) and US7-1 (spec.md:169). P14's claim at docs/decisions.md:613 is now true. The paragraph is indented 3 spaces, so it renders as a plain paragraph between steps 3 and 4, not as a code block. Its scope is a separate question, recorded as MINOR F10.
      traces: FR-028, US7-1, Edge Cases "Retry loop", P14

- [x] MAJOR F2 — **Resolved.** The webhook assertions for SC-003 and SC-005 could never fail, and the parity checks covered only one retry mode and one resolve outcome
      where:  tests/integration/api/endpoints/recovery-idempotency.test.ts:29, :38, :46, :55-65; tests/integration/api/endpoints/recovery-attribution.test.ts:143-194
      why:    (original) No endpoint was subscribed, so `emitEvent` returned early (src/server/services/webhooks/emit.ts:48-49) and every event count was 0.
      check:  `common()` now subscribes an endpoint to `post.published` and `post.failed` (recovery-idempotency.test.ts:29). Bulk uses `common()` too (:122), so the bulk replay's `observe` is no longer vacuous. The resolve case asserts that the first call writes exactly one event (`emits: 1`, :46, :60). That assertion passes, so events are now recorded, and a second emission on replay would fail `toEqual(before)` at :65. The parity suite subscribes both the API env and the member env (:143-144, :160-161, :178-179). It runs `it.each` over retry `now`, `requeue` and `at` (:153-158), and over resolve `published`, `not_published`/`requeue:false` and `not_published`/`requeue:true` (:171-176). Resolve asserts its own event delta (`event ? 1 : 0`, :190) and checks that `post.published` is present. `at` is `2026-10-06T09:00Z`, after `LATER` (`2026-10-05T09:30Z`, tests/helpers/failures.ts:11), so the scheduled path is exercised rather than `in_past`. Both files pass (23 tests). The scrub now recurses into nested objects (:131-139). It therefore ignores `scheduledAt`/`slotId` inside attempt summaries as well as at the top level, which is necessary because slot ids differ between projects. The instants themselves are asserted per operation (retry-target.test.ts:34, :54), so parity loses nothing it needs.
      traces: SC-003, SC-005, FR-025, FR-030

- [ ] MINOR F3 — (open, unchanged) A retry's `expected` is stored in the attempt summary in the caller's offset form, unlike the UI (UTC) and the API resolve path (normalised)
      where:  src/server/api/operations/targets.ts:169, src/server/services/posts/retry.ts:139, contrast src/server/api/operations/targets.ts:256
      why:    Unchanged from the first review. `requeueTarget` writes `requestSummary.expected` verbatim. FR-018 asks for a request summary identical to the UI's.
      owed:   Normalise retry `expected` to UTC in the operation, as resolve already does.
      traces: FR-018

- [ ] MINOR F4 — (open, unchanged) No test exercises the recovery operations without an `Idempotency-Key` (US5-4)
      where:  tests/integration/api/endpoints/retry-target.test.ts:18, src/server/api/handle.ts:159-162
      owed:   Add a keyless double-retry test: first `200`, second `409` with `details.reason: "not_failed"`.
      traces: US5-4, FR-030

- [ ] MINOR F5 — (open, unchanged) The secret scan does not look for the key's `last4` in the attempt-log page, although T030 says it does
      where:  tests/integration/security/secret-scan.test.ts:290-296
      owed:   Assert that the rendered Failures-page piece does not contain the write key's `last4`.
      traces: FR-026, SC-007

- [ ] MINOR F6 — (open, unchanged) No test checks the recovery recipe's requests against the OpenAPI document
      where:  tests/integration/docs/n8n-flow.test.ts:42
      owed:   Parse the §7 `http` blocks and match method, path template and body keys against `buildOpenApiDocument()`.
      traces: US7 Independent Test, FR-028

- [ ] MINOR F7 — (open, unchanged) Docs and comments say things the code does not do
      where:  src/server/api/operations/targets.ts:85, docs/n8n.md:132, docs/decisions.md:601, src/lib/api/schemas.ts:241, src/server/api/operations/types.ts:20-21
      why:    (a) The `retryPostTarget` description and docs/n8n.md:132 call `no_active_slots` "a refusal" returned in a `200`. Under D3, refusals are `409`, and the `200` cases are typed outcomes. Line 132 now sits directly above the new cap paragraph, so a reader meets it on the way in. (b) P2 says "discriminated union", but the code is a plain `z.union`. (c) A stray comment sits above `ApiExamples`.
      owed:   Reword (a) as "a typed outcome such as `no_active_slots` …". Make (b) say `z.union`. Move or delete (c).
      traces: FR-027, FR-029, D3

- [ ] MINOR F10 — (new, noticed in re-review) The recipe's bulk step has no cap, so the per-target counter does not protect a flow built on it
      where:  docs/n8n.md:137 (step 5), contrast docs/n8n.md:134
      why:    Step 5 of the same flow offers `POST /targets/retry-failed` as the way "to retry everything at once". The new counter is kept per `targetId` and sits under step 3, so a builder who wires step 5 to `post.failed` keeps no counter. Take a project with one target that always fails. Each bulk call retries it, it fails, a new `post.failed` arrives, and the loop has no limit. This is the same loop F1 described, reached through the other branch of the recipe. FR-028 attaches the limit to the per-target retry, so this is MINOR, not a reopened F1.
      owed:   Say in step 5 that bulk retry is for a person or a schedule, not a reaction to every `post.failed`. Alternatively, say that a webhook-driven flow must use step 3 with its counter.
      traces: FR-028, Edge Cases "Retry loop"

- NOTE F8 — (unchanged) A resolve body with `outcome: "not_published"` and no `requeue` is rejected with one detail at `path: ""` and the message "Invalid input". The cause is the plain `z.union` at src/lib/api/schemas.ts:241. This meets FR-009, but it gives the caller no hint about which field is missing.

- NOTE F9 — (unchanged) On the Failures page, grouped runs show no "Who" (src/app/p/[projectSlug]/failures/page.tsx:103-118). This predates 016.

- NOTE F12 — The first review and T037's text said that resolve `not_published`/`requeue:false` should emit `post.failed`. That was wrong, and the implementer was right to assert zero events instead (recovery-attribution.test.ts:173, :190). `derivePostStatus` counts `ambiguous` as not published (src/server/services/posts/status.ts:9-17). So a post whose only live target is ambiguous already has status `failed`, and resolving that target to `failed` does not change the post status. `applyDerivedStatus` emits only on a change (status.ts:31-34). None of the three operations can move a post *into* `failed`/`partially_failed`, so `post.failed` is never directly reachable from them. That leaves resolve `published` → `post.published` as the only emission to test, plus "no event" for everything else, and the remediated suites cover both.

## Coverage

Counts reflect the whole feature after remediation. Rows that this pass did not re-derive carry the first review's result, and say so.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-030) | 30 | 28 | 2 (FR-018 F3; FR-030 F4/F6, MINOR) | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 8 | 0 | 0 | 0 |
| User stories (US1–US7) | 7 | 7 | 0 | 0 | 0 |
| Spec decisions (D1–D10), carried | 10 | 10 | 0 | 0 | 0 |
| Plan decisions (P1–P15) | 15 | 15 | 0 | 0 | 0 |
| Constitution principles (I–VII), carried | 7 | 7 | 0 | 0 | 0 |
| Earlier blocking findings (F1, F2) | 2 | 2 fixed | 0 | 0 | 0 |

## What I could not check

- **A real n8n run of the capped recipe.** Workflow static data and the alert step were not exercised in n8n. I checked the text against the spec, not its behaviour in a live workflow.
- **Delivery over HTTP.** The tests subscribe `http://127.0.0.1:9/x` and count `webhook_events` rows. No event was delivered to a receiver.
- **The full suite, lint, typecheck and build after `b06628e`.** These were not re-run (constitution review rule). The remediation changed only two test files and one doc, and both test files pass. CI on a PR has not been seen, because this phase cannot open one.
- Everything in the first review's list is still unchecked: SC-008 timing through the API, browser rendering of "API key {name}", the quickstart walk-through with curl and `pnpm dev`, and Neon pooled mode.
