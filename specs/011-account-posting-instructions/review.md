# Review: Account posting instructions (011)

**Second review, 2026-10-05: a re-review after remediation.** It covers 104 files changed across 6 commits, against `9c809ce...HEAD` (`9c809ce` is the merge-base with `origin/main`; HEAD is `3ad4173`). The working tree is clean, so this time the diff is the whole feature. There is no uncommitted work.

Under constitution § Development Workflow ("Review is exhaustive once, then scoped"), this pass checks two things only:

- that each finding from the first review (F1–F10) is fixed or still correctly classified;
- that the files the remediation touched introduced no regression.

The first review's full sweep (every FR and SC, concurrency, idempotency, authz, error paths, secrets) is not repeated. Anything new that I noticed is recorded as MINOR.

**Read in full** (remediation files and the code that consumes them):

- `src/app/p/[projectSlug]/generate/result/[postId]/{VariantEditor.tsx,variant-logic.ts}` and the diff of `src/app/p/[projectSlug]/generate/result/result.test.tsx`;
- `src/lib/action-result.ts` and the diff of `src/lib/action-result.test.ts`;
- `tests/integration/generation/group-limit.test.ts`;
- `src/server/services/generation/groups.ts`;
- the diffs of `generation/{regenerate,save}.ts` and `review/ReviewList.tsx`;
- `src/app/p/[projectSlug]/run-action.ts`.

**Sampled** (the lines that matter for a finding):

- error handling in `GenerateForm.tsx`, `RegenerateDialog.tsx`, `TryItPanel.tsx` and `JobForm.tsx`;
- every `new ValidationIssuesError` throw site: `jobs/sources/{csv,api,media}.ts`, `jobs/create.ts`, `posts/index.ts` and `generation/groups.ts`;
- where `assertGroupLimit` sits relative to `recordFailure` in `generation/{single,series,regenerate}.ts`;
- the keys in `services/review.ts` and `posts/variant-groups.ts`;
- the test names in `tests/integration/jobs/posting-instructions.test.ts`;
- `docs/generator.md:35-47` and `docs/decisions.md:466-478`;
- the problem label on the result page.

**Not reviewed again:** every other file in the diff. The first review read them, and this pass does not reopen them. The generated `drizzle/meta/*_snapshot.json` files were not reviewed in either pass.

**Ran** (targeted, with real Postgres and the fake LLM):

```
pnpm vitest run src/lib/action-result.test.ts tests/integration/generation/group-limit.test.ts src/app/p/[projectSlug]/generate/result/result.test.tsx
```

Result: **3 files, 32 tests passed**. Per the constitution, I did not run lint, typecheck, the full suite or build.

## Verdict

**The feature now satisfies the spec and hangs together. Nothing blocks the merge.** All three MAJOR findings are fixed, and each fix has a test that would fail against the old code:

- **F1, editing split groups:** the variant editor's state is keyed by group key throughout, through a pure helper with a unit test. Review uses the same component and passes the same `key`.
- **F2, the refusal message:** the group-limit refusal keeps its message through `failFromError`, which also sets `fieldErrors.targetAccountIds`. So Generate (beside the account picker), regenerate and Try it all show the text naming 17 and 16.
- **F3, missing tests:** the group-limit suite now covers Try it, uses the refused request's own `requestId`, and asserts that no failure row is written on the single, Try it and `/generate` paths. It also asserts that `/generate` creates no post.

The remediation introduced no regression I could find. The one design change, a wider `failFromError` rule than the plan's `GroupLimitError`, is safe: every other thrower it affects already carries a message written for users. It is not recorded in `docs/decisions.md`, though (F11).

The MINOR findings from the first review (F4–F7) are still open. They were not given remediation tasks, which is correct for MINOR.

Two things stand between this branch and a merge, and neither is a code defect:

- **T047 is still open.** `pnpm lint`, the full `pnpm test` and `pnpm build` have not run on this code. The host load average was 78–150 during this review.
- **The branch is not pushed**, so no CI run exists.

The constitution's merge gate is green CI, so the PR's CI run settles this.

## Findings

- [x] MAJOR F1 — **Fixed.** The variant editor now reads and writes live text by the card's group `key`, so editing `bluesky_2` changes only that group's targets.
      where:  src/app/p/[projectSlug]/generate/result/[postId]/VariantEditor.tsx:27, VariantEditor.tsx:32, VariantEditor.tsx:65, VariantEditor.tsx:115, src/app/p/[projectSlug]/generate/result/[postId]/variant-logic.ts:17, variant-logic.ts:22, src/app/p/[projectSlug]/review/ReviewList.tsx:159
      why:    The changes are:
              - `useState` is seeded by `c.key`;
              - `live` comes from `liveCards(cards, texts)`, which reads `texts[c.key]`;
              - `edit(c.key, …)` is wired to `onChange`;
              - save and approve both send `editsFor(live)`, as `{ accountIds, text }`.
              `VariantCard.key` is a required field, and Review now passes `key: v.key`.
      test:   `result.test.tsx:191` would fail against the old `texts[c.providerKey]` lookup. Both cards share `providerKey: "bluesky"`, so the old code would have returned `"one"` for both. It passed in this run.
      traces: FR-011, US2 scenario 7, SC-002

- [x] MAJOR F2 — **Fixed.** A group-limit refusal raised through a server action now carries its own message, plus `fieldErrors.targetAccountIds`, and does not fall back to the generic "Some posts have validation problems."
      where:  src/lib/action-result.ts:81, action-result.ts:86, action-result.ts:96, src/app/p/[projectSlug]/run-action.ts:16, src/app/p/[projectSlug]/generate/GenerateForm.tsx:132, GenerateForm.tsx:282, src/app/p/[projectSlug]/generate/result/[postId]/RegenerateDialog.tsx:23, src/app/p/[projectSlug]/voice/TryItPanel.tsx:56
      why:    `failFromError` now keeps the message of any `ValidationIssuesError` whose `issues` is a non-empty flat array. It copies each issue's `field` into `fieldErrors`. How each form shows it:
              - `GenerateForm` puts the message in the top error and beside the account picker (lines 282–283).
              - `RegenerateDialog` and `TryItPanel` show `r.message`, which is now the real text.
              - Grouped (per-post) issues, such as `posts/index.ts:294`, keep the generic message, so nothing per-post leaks into a whole-form error.
      test:   `action-result.test.ts:21` feeds a real `assertGroupLimit` throw into the real `failFromError` and asserts the message names 17 and 16 and lands in `fieldErrors.targetAccountIds`. The test passed. It is a composition test, not a server-action test. `runAction` adds nothing between the two (`run-action.ts:16`), so it does prove the mapping. The client rendering of `r.message` is established by reading only (see "What I could not check").
      traces: FR-012, FR-013, US3 scenario 1

- [x] MAJOR F3 — **Fixed.** The group-limit suite covers every FR-012 caller, and its "nothing created" assertions now check the refused request.
      where:  tests/integration/generation/group-limit.test.ts:54, group-limit.test.ts:55, group-limit.test.ts:58, group-limit.test.ts:62, group-limit.test.ts:141, group-limit.test.ts:142
      why:    The changes are:
              - The single case asserts `findByRequestId(requestId)` on the refused request's own id (line 54), plus zero failure rows (line 55).
              - A new Try it case (line 58) passes 17 groups via `accountIds`. It asserts the 17/16 message, zero model requests and zero failure rows.
              - `/generate` asserts zero posts and zero failure rows (lines 141–142).
              Regenerate and series do not assert failure rows. They hold by construction, because `assertGroupLimit` runs before any `recordFailure` (`single.ts:198` before `:218`, `series.ts:226` before `:238`, `regenerate.ts:67` before `:92`).
      test:   The suite passed: 7 tests.
      traces: FR-028, FR-012, SC-004, US3 scenario 4

- [ ] MINOR F4 — Still open from the first review. The result screen labels remaining problems with the bare group key (`bluesky_2: …`), not the stored group label (`bluesky_2 (Bluesky: Acme News): …`) that the API uses.
      where:  src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:56
      owed:   Use `p.label ?? p.groupKey ?? p.providerKey`, as `src/server/api/operations/generate.ts` does. (Plan § "After the 2026-10-05 review" step 3 lists this, but no task was created for it.)
      traces: FR-010

- [ ] MINOR F5 — Still open from the first review. Try it's default account selection is implemented twice, so the two copies can drift (constitution IV).
      where:  src/server/services/voice.ts:280, src/app/p/[projectSlug]/voice/TryItPanel.tsx:17
      owed:   Export one `defaultTryItSelection` from `src/lib/generation/groups.ts` and use it in both places. Plan D12 and § "After the 2026-10-05 review" step 4 name this function, but it does not exist yet.
      traces: FR-020, constitution IV

- [ ] MINOR F6 — Still open from the first review. No test covers the deferred correction retry or manually retried job items running under the snapshot, and no test renders the job page's snapshot list.
      where:  tests/integration/jobs/posting-instructions.test.ts:71, src/app/p/[projectSlug]/jobs/[jobId]/page.tsx:110, jobs/[jobId]/page.tsx:117
      owed:   Add a deferred-retry case and a `retryItem` case that assert the prompt contains the snapshot text after an edit. Add a render assertion for "Posting instructions (as of job creation)" and "Not recorded".
      traces: FR-016, US5 scenarios 2 and 5

- [ ] MINOR F7 — Still open from the first review. `docs/generator.md` says "The forms show a live group count." In fact they show the group-limit message only once the selection is over 16.
      where:  docs/generator.md:43
      owed:   Reword to: "The forms warn as soon as the selection needs more than 16 groups."
      traces: FR-026

- [ ] MINOR F11 — New. The F2 fix is broader than the planned design, and the choice is not logged in `docs/decisions.md`.
      where:  src/lib/action-result.ts:86, src/lib/action-result.ts:96, specs/011-account-posting-instructions/plan.md:20, plan.md:206, docs/decisions.md:466
      why:    Plan D5 named a dedicated `GroupLimitError` and said to record that choice in `docs/decisions.md` § 011. Instead, every flat-issue `ValidationIssuesError` now keeps its message and fills `fieldErrors`. The callers affected:
              - CSV file errors (`jobs/sources/csv.ts:101`, `:105`);
              - media selection (`jobs/sources/media.ts:35`);
              - job template issues (`jobs/create.ts:36`).
              I checked each thrower. All their messages are written for users, so nothing leaks. The visible change on the job form is that template and account-picker errors now appear inline as well as in the summary.
              The rule is implicit: "a flat issue list means a user-facing message." A future thrower that passes a flat list with an internal message would show it to the person.
      owed:   Add a `docs/decisions.md` § 011 entry for the rule and the reason it replaced `GroupLimitError`. Or narrow the rule to a named error class, as the plan describes.
      traces: constitution § Docs ("appends any judgement call to `docs/decisions.md`"), plan D5

- NOTE F8 — **Resolved, with a caveat.** The implementation is now committed, so the tree is clean. But it went in as two broad commits, `366d842` (41 files) and `3ad4173` (50 files, including the remediation and `review.md`). The constitution asks for a commit per task or per small group of tasks. The trailer reads `Claude Sonnet 5.5` rather than the constitution's `Claude Opus 5.5`. Both commit types are `feat`, which is accurate for semantic-release. Rewriting this history now would cost more than it returns.
- NOTE F9 — **Still open.** T047 (`tasks.md`, marked `🛑 BLOCKED`) is unchecked: `pnpm lint`, the full `pnpm test` and `pnpm build` have not run on this code, and the branch is not pushed, so there is no CI. Until they run, the integration suites that neither review executed are claims, not results. These are accounts, the migration, jobs, review, API, OpenAPI and voice. Green CI on the PR is the merge gate.
- NOTE F10 — The 16-group limit still rests on the UNVERIFIED research item R1. It is one constant (`src/lib/generation/groups.ts:4`) and is logged in `docs/decisions.md:470`. Model compliance with the instructions is "verified with fakes only".

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-028) | 28 | 28 | 0 | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 8 | 0 | 0 | 0 |
| Acceptance scenarios (US1–US7) | 39 | 39 | 0 | 0 | 0 |
| Spec edge cases | 13 | 13 | 0 | 0 | 0 |
| Constitution principles I–VII | 7 | 7 | 0 | 0 | 0 |
| First-review findings re-checked (F1–F10) | 10 | 3 fixed (F1–F3), 1 resolved (F8) | — | — | 4 MINOR still open (F4–F7), 2 notes carried (F9, F10) |
| Constitution workflow (commits, quality gates) | 2 | 0 | 2 (F8 coarse commits; F9 T047 open) | 0 | 0 |

How to read these counts:

- **Re-checked in this pass:** FR-011, FR-012, FR-013 (the server-error leg), FR-028, SC-002, SC-004, and US2-7, US3-1 and US3-4.
- **Carried from the first review:** the other FR, SC, scenario, edge-case and principle results, unchanged. No remediation file touches them.
- **Satisfied, with an open MINOR:** FR-010 (F4), FR-016 (F6, holds by construction), FR-020 (F5) and FR-026 (F7).
- **SC-001** is satisfied on design only. Timing cannot be measured headlessly.

## What I could not check

- **Client components in a browser.** The repo has no jsdom or testing-library, and this phase has no browser. Two behaviours are established by reading and by unit tests of the pure helpers, not by interaction:
  - typing into a split-group card (F1);
  - the refusal text showing in `GenerateForm`, `RegenerateDialog` and `TryItPanel` (F2).
- **The quality gates (T047).** `pnpm lint`, `pnpm typecheck`, the full `pnpm test`, `pnpm build`, the Docker build, and CI on a pushed branch. The constitution keeps these out of review. None has run on HEAD that I can see: T047 is open and nothing is pushed.
- **Integration suites neither review executed.** These are:
  - `accounts-posting-instructions`
  - `migrations/copy-platform-guidance`
  - `jobs/posting-instructions`
  - `generation/{posting-instructions,try-it-accounts}`
  - review, the API endpoints, OpenAPI and voice

  Their assertions were read in the first review.
- **Real-model behaviour.** Whether Anthropic or OpenAI accept 16 required variant properties (R1), and whether the model follows the per-group instructions. Both are verified with fakes only.
- **The migration on a real upgraded database.** That covers the Neon direct URL, `ALTER TYPE … ADD VALUE` inside the migrator's transaction, and real voice content. Only the throwaway-DB test exists, and I did not run it.
