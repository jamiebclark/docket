# Review: Generator core (LLM layer, voice profiles, single and series generation, approval policy, review queue)

Reviewed 166 file(s) changed against `8b634cd` (merge-base with `origin/main`). Only 55 of them are in the branch's 4 commits (`d9054de`, `2fb0fda`, `c360272`, `7ed2004`). The other 111, which cover US2–US6, polish, migration `0004` and the new DAL repositories, exist only as uncommitted or untracked files in the working tree (see F3). So this review covers **base → working tree**, not base → HEAD.

**Read in full:**

- `src/server/services/generation/{core,policy,single,regenerate,series,failures,schema,prompt}.ts`, `src/server/services/{review,voice}.ts`
- `src/server/llm/{openai,anthropic,config,index,log,images,image-generation}.ts`
- `src/server/dal/{voice,series}.ts`, `src/server/db/schema/generation.ts`
- the three `actions.ts` files (generate, review, voice)
- `ReviewList.tsx`, `VariantEditor.tsx`, `result/[postId]/page.tsx`, `review/page.tsx`, `generate/page.tsx`, `series/[seriesId]/{page,SeriesWriter}.tsx`, `series-logic.ts`, `variant-logic.ts`
- the diffs of `services/posts/{index,list,status,validate}.ts`, `services/{projects,media-variants}.ts`, `dal/{posts,scope,errors}.ts`, `db/schema/{posts,projects}.ts`, `auth/access.ts`, `lib/action-result.ts`, `layout.tsx`, `LeftNav.tsx` and `startup/index.ts`
- the first 80 lines of `drizzle/0004_lowly_silver_surfer.sql`
- these tests: `tests/integration/generation/{policy-matrix,regenerate}.test.ts`, `tests/integration/posts/rejected-gate.test.ts`, `src/server/services/generation/policy.test.ts` (resolve/decide parts) and `result/result.test.tsx`

**Sampled:**

- `GenerateForm.tsx` (the submit and request-id logic)
- `VoiceEditor.tsx` and `TryItPanel.tsx` (conflict handling and draft/version wiring)
- `contracts/services.md`, `contracts/ui.md`, research D21, and the 007 entries in `docs/decisions.md`

**Not reviewed:**

- `PolicyPicker.tsx`, `SeriesPlanEditor.tsx`, `RejectDialog.tsx`, the voice list/new/history pages, `settings-form.tsx`
- `scripts/llm-check.ts`, `tests/helpers/fake-llm*.ts` and `llm-scenarios.ts`
- most render and integration tests apart from those listed above
- `README.md` and `docs/generator.md`

The reason is time spent on the service layer, where the cross-pass risk is highest. Their behaviour is covered only by the tests that implement already ran.

**Executed:** `pnpm vitest run tests/integration/generation/policy-matrix.test.ts tests/integration/review tests/integration/generation/series.test.ts tests/integration/voice` → 6 files, 49 tests, all passed on the working tree. Per the constitution I did not re-run the full suite, lint, typecheck or build.

## Verdict

**Not ready to merge: 3 MAJOR findings, no BLOCKERs.**

The service layer holds together well across passes:

- one `runGeneration` with a two-call ceiling;
- one `decidePolicy` and `applyApprovalPolicy` used by single and series;
- `queueTargetsInTx` extracted unchanged and reused by approval;
- the post row lock as the approval arbiter;
- scoped repositories with composite FKs;
- keys read in `config.ts` only;
- no model call inside a transaction.

The spec's main safety property, that no invalid post is approved or queued automatically (SC-003), holds. Three things block the merge:

1. **F1:** regenerate does not use the one approval-policy service, which FR-024 names it as a caller of. Its own inline rule lets a human-approved post keep `approved` after its content is replaced by new model text that nobody reviewed. A test asserts this behaviour.
2. **F2:** the result screen, the first screen of P1 Story 1, shows no `used / limit` counts until the person types.
3. **F3:** almost the whole feature is uncommitted. The branch HEAD references modules that do not exist at HEAD, so what would be pushed does not compile.

Fix those three (tasks T080–T082 below). The MINOR items can go to a hardening entry.

## Findings

- [x] MAJOR F1 — Regenerate bypasses the single approval-policy service, and its own copy of the rule leaves new, unreviewed content approved.
      where:  src/server/services/generation/regenerate.ts:132-153, tests/integration/generation/regenerate.test.ts:71-75
      why:    FR-024 says the one policy service "is used by single mode, series mode and regenerate now", and constitution IV says approval policy has exactly one implementation. `regeneratePost` never calls `decidePolicy` or `applyApprovalPolicy`. It re-implements the forced-review rule inline (`blocking` → `needs_review`, reason `Forced to review: …`) and otherwise keeps whatever review state the post had. The two rules diverge as follows:
              - a post in a `review_required` project that a reviewer approved (status `approved`, `leave_as_draft`, so still unscheduled) is regenerated from the result page;
              - its text is replaced by entirely new model output;
              - it stays `approved`, so content no human has seen is approved under a review-required policy, contrary to FR-022 ("never approves").
            The same happens if a reviewer approves the old text while someone's regenerate call is in flight: the lock is re-taken only for the write, and the targets are still `draft`. `regenerate.test.ts:71-75` asserts that the approved state is kept after valid new content, so the suite enforces the divergence. A regenerate on a `rejected` post is also allowed and leaves it `rejected` (regenerate.ts:51-58).
      owed:   Derive the regenerated post's review state from `decidePolicy` with the record's resolved policies, and never move `needs_review` to `approved`. The result should be: `approved` only when the resolved policy is `auto_approve` and nothing blocks; otherwise `needs_review`. Never queue. Decide and document whether a `rejected` post can be regenerated: either refuse, or move it back to `needs_review`. Change `regenerate.test.ts:71-75` to expect `needs_review` for a human-approved post under `review_required`, and add a case for `auto_approve`.
      traces: FR-022, FR-024, constitution IV, SC-003 (spirit)

- [x] MAJOR F2 — The single-post result screen shows no `used / limit` counts or live issues until the person edits a variant.
      where:  src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:85-91, src/app/p/[projectSlug]/generate/result/[postId]/VariantEditor.tsx:28,39-47,86-110
      why:    `VariantEditor` starts with `check = initialCheck`, which defaults to `null`. It calls `fetchCheck` only from `edit()`; there is no fetch on mount. The result page never passes `initialCheck`, so `cardCheck(null, c)` returns `null` and every counter renders empty. Story 1 scenario 1 requires that "the result screen shows each variant with `used / limit` counts from that platform's own counting rule". The ticked T033 says the same, and contracts/ui.md "Result" describes a `used / limit` per card. The render test (`result/result.test.tsx:64-72`) checks the decision, the text and the details, but never a count, so the gap went unnoticed. The review queue builds its counts on the server (`review.ts:63-91`), so the two screens that share this editor disagree.
      owed:   Give the editor counts from the first render. Either compute the per-target count, limit and issues on the server in the result page (as `buildItem` does for review) and pass them as `initialCheck`, or run one `fetchCheck` on mount. Add a render assertion for `n / limit` on the result page.
      traces: US1 acceptance scenario 1, FR-033, T033

- [x] MAJOR F3 — Most of the feature is uncommitted, and the branch HEAD does not compile on its own.
      where:  src/server/services/generation/single.ts:137, src/server/services/generation/single.ts:198 (as committed in 7ed2004); untracked src/server/dal/voice.ts, src/server/dal/series.ts, src/server/db/schema/generation.ts, drizzle/0004_lowly_silver_surfer.sql
      why:    HEAD's `single.ts` calls `scope.voiceProfiles.get` and `scope.posts.findByRequestId`. At HEAD, `src/server/dal/scope.ts` has no `voiceProfiles`, the `findByRequestId` repo method is absent, and `src/server/dal/voice.ts` is not in the tree (verified with `git show HEAD:src/server/dal/scope.ts` and `git ls-tree HEAD src/server/dal/`). The following exist only in the working tree:
              - 111 files: US2 (voice), US3 (review UI), US4, US5 (series UI), US6 tests, polish tests and docs;
              - the migration and its snapshot;
              - the `rejected` enum change.
            Pushing HEAD would ship a typecheck failure and none of US2–US6. The constitution's workflow requires a commit after each completed task, with explicit paths and Conventional Commit types. Feature 006 followed that; this feature stopped after US1.
      owed:   After T080 and T081, commit the working tree in logical Conventional Commits staged by explicit path. Never use `git add -A` or `git add .`. A suggested split: foundational schema/DAL/migration; LLM layer and Anthropic; voice (US2); review (US3); policies (US4); series (US5); provider parity, startup and llm:check (US6); docs; tests per story. Each commit ends with the required trailer. Then confirm `git status` is clean apart from intended files, and that `pnpm typecheck` passes at HEAD.
      traces: constitution Development Workflow (Commits, Quality gates)

- [ ] MINOR F4 — Series planning makes a model call for a request that `startSeries` will refuse.
      where:  src/server/services/generation/series.ts:81-84, src/server/services/generation/series.ts:166-170
      why:    `planSeries` parses `approval`, `scheduling` and `confirmUnreviewedQueue` but never calls `resolvePolicies`. An editor asking for an `auto_approve` override, or anyone choosing auto + queue without the confirmation, still gets a model call and a plan. The refusal arrives only at "Write posts". The contract says `resolvePolicies` "is called before any model call, so a refused request generates nothing" (Story 4 scenario 5). Nothing is saved, so no post skips review (SC-010 holds), but the person spends a call and is refused late.
      owed:   Call `resolvePolicies` at the top of `planSeries`, as `generateSingle` does.
      traces: FR-026, FR-027, Story 4 scenario 5

- [ ] MINOR F5 — `writeSeriesPost` and `getSeries` do not parse their ids with Zod.
      where:  src/server/services/generation/series.ts:204-216, src/server/services/generation/series.ts:224, src/server/services/generation/series.ts:310-320, src/app/p/[projectSlug]/generate/actions.ts:59
      why:    The contract says inputs are `unknown` and parsed with Zod. A non-uuid `seriesId` (for example `/p/x/generate/series/abc`) reaches Postgres and raises `22P02`. That renders the error boundary instead of not-found, unlike `getPost`, which parses with `uuid.parse`. A crafted `position: "0"` from the action passes `angles[position]`, but then `i !== position` is always true. The post's own angle is then listed under "do not repeat", and `total` is off by one.
      owed:   `z.uuid().parse(seriesId)`, mapped to not-found, and `z.number().int().min(0).max(9).parse(position)` at the top of both functions.
      traces: FR-023, contracts/services.md preamble

- [ ] MINOR F6 — The navigation badge loads up to 50 full post rows on every project page just to count them.
      where:  src/server/services/review.ts:120-123, src/app/p/[projectSlug]/layout.tsx:37
      why:    `countReviewQueue` calls `posts.listReviewQueue(1)`, which selects `*` (including `generation_metadata`, which holds the full prompts and up to 50,000 characters of source text per record) for 50 rows, and discards everything except `total`. This runs in the project layout on every navigation.
      owed:   Add a count-only repository query, or reuse `posts.counts().needs_review`.
      traces: plan Performance Goals

- [ ] MINOR F7 — Cross-pass dead ends and a duplicated retry loop.
      where:  src/server/services/generation/core.ts:29-30, src/server/services/generation/core.ts:114, src/server/services/generation/core.ts:138, src/server/services/generation/prompt.ts:211, src/server/services/generation/series.ts:79-159
      why:
            - `CoreOutcome.warnings` is computed, and documented as "shown on the result", but no caller stores or shows it.
            - `describeProblems` (T019) is exported and never used; core uses `problemLine` instead.
            - `planSeries` re-implements the two-call retry rule with its own `RETRYABLE` set instead of sharing `runGeneration`'s. The two copies agree today, but SC-004's "never more than two calls" now lives in two places.
      owed:   Remove or wire `warnings` and `describeProblems`. Factor the retry rule into one helper that both callers use.
      traces: FR-015, SC-004

- [ ] MINOR F8 — Two edit paths validate differently.
      where:  src/server/services/review.ts:22, src/server/services/review.ts:180-187, src/server/services/posts/index.ts:295-300
      why:    "Save" on the result screen goes through `updatePostVariants`, which limits text with `baseTextSchema` (`POST_TEXT_MAX`) and runs `updatePost`. "Save and approve" in review writes `override_text` directly with `z.string()` (no length cap). Per the contract it keeps the edit even when validation fails, so over-long text is persisted, limited only by the server-action body size.
      owed:   Use `baseTextSchema` for `approveSchema.edits[].text`.
      traces: FR-022, FR-030

- [ ] MINOR F9 — A throw after the post is saved leads to a duplicate post on retry.
      where:  src/server/services/generation/single.ts:279, src/app/p/[projectSlug]/generate/GenerateForm.tsx:152
      why:    The post is committed first. If `applyApprovalPolicy` then throws (for example `ConflictError("This post was already reviewed.")` when a reviewer approves it from the queue in that window, or a DB error while queueing), the form shows an error and replaces the `requestId`. "Try again" then generates and saves a second post, making two more model calls. The window is narrow.
      owed:   Keep the same `requestId` after a thrown error, so a retry returns the existing post. Optionally, have `generateSingle` return the saved post with the policy error as a note.
      traces: Edge case "Double submit", research D13

- [ ] MINOR F10 — The result page shows unrounded latency, labels rejected posts "In review", and repeats problems that may already be fixed.
      where:  src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:55, src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:56, src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:119, src/server/services/generation/core.ts:57
      why:
            - `latencyMs` comes from `performance.now()` deltas and is printed as `${a.latencyMs} ms`, for example `1532.417083 ms`.
            - `decisionText` maps every non-approved state, including `rejected`, to "In review".
            - `remainingProblems` comes from the stored record, so it stays listed as "Error:" after an edit has fixed it.
      owed:   Round the latency, label rejected posts, and drop the record's problems once a live check exists (see F2).
      traces: FR-033

- NOTE F11 — Bulk approve approves a post whose only account has no posting slots: it is approved, left unscheduled and reported with "This account has no posting slots". The alternative reading would leave it in review. This follows Story 3 scenario 9 and the T044 test, and reads scenario 6's "can no longer be queued" as already reviewed or not queueable (`review.ts:245-269`). It is consistent and defensible; the owner may want to confirm it.
- NOTE F12 — `generate/page.tsx:62` lists profiles with `scope.voiceProfiles.list()` rather than `listVoiceProfiles`. Repository access through the scope is allowed by constitution III. This is the only UI page in the feature that skips the service.
- NOTE F13 — Live latency (T079, FR-037) is unmeasured and `docs/decisions.md` says so ("latency: unmeasured; live path verified with mocks only"). This is the correct outcome for a run without a key.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-037) | 37 | 35 | 2 (FR-022, FR-024: F1) | 0 | 0 |
| Success criteria (SC-001–SC-011) | 11 | 10 | 0 | 0 | 0 (SC-001 timing not measurable here) |
| User stories (acceptance scenarios) | 6 | 5 | 1 (US1 scenario 1: F2) | 0 | 0 |
| Constitution principles and constraints (I–VII, no call in a held transaction, UI via docket-ui, commit workflow) | 10 | 8 | 2 (IV: F1; commits: F3) | 0 | 0 |

How the main obligations were checked:

- **FR-001/002:** both providers re-validate with `schema.safeParse` and map refusal, truncation and SDK errors to the eight kinds.
- **FR-003:** `parseLlmConfig` is never fatal and names only the missing settings; startup logs it.
- **FR-005:** images go by public https URL when fetchable, otherwise as bytes, with a variant for oversized images and a base64 budget.
- **FR-006:** the SDK timeout plus an `AbortSignal` bound the call, with `maxRetries: 2`.
- **FR-013:** the section order in `prompt.ts`, and source text fenced in `<source_material>` with its closing tag neutralised.
- **FR-015/016 and SC-004:** at most two calls in `core.ts`.
- **FR-017:** the record fields in `buildRecord`.
- **FR-023:** idempotency through `posts_series_position_uq` and `findBySeriesPosition`.
- **FR-025/031:** `queueTargetsInTx` runs under the post lock, and `already_reviewed` is returned on a second approval.
- **FR-032:** `queueableGate` refuses `rejected` for queue, explicit time and publish-now (`rejected-gate.test.ts`).
- **FR-034:** four project-owned tables with composite FKs, reached through scoped repositories.
- **FR-035:** the log has fixed fields with `redact`, and SDK error text is never surfaced.

## What I could not check

- **Browser behaviour:** keyboard-only flows, visible focus, screen-reader output of the bulk bar and the plan editor, and the pending-button behaviour in a real browser. I only read the components; the render tests use static markup.
- **Live providers:** OpenAI and Anthropic calls, R1 (OpenAI per-image byte limit and URL fetching), R4 (Anthropic schema complexity limits on a real request), and real latency (T079). There is no key, and this phase has no network.
- **SC-001** ("under 2 minutes from Generate to a saved post") is a human-timing measure.
- **Gates not re-run:** `pnpm build`, `pnpm db:check`, the Docker image and the full suite, per the constitution's review rule. Their results could not be confirmed from CI either, because the work is not committed (F3). T077 is ticked, but nothing on disk records its output.
- **Neon or pooled-connection behaviour** of the new transactions and locks.
- **Files not read** (see the header), beyond what their tests assert.
