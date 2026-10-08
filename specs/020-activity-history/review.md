# Review: Activity history — one log of publish successes and failures, per project and across projects

**Re-review after remediation (Phase 10, T066–T070).**

Reviewed 109 changed files against `078bda9` (the merge-base with `origin/main`):
- 3 commits (`d4bf52c`, `f546301`, `0942716`);
- the uncommitted working tree: 60 tracked files differ from the base, and 49 are untracked.

Most of the implementation is still uncommitted. This review therefore covers the present working tree against the base, not only `078bda9...HEAD`.

The constitution (§ Workflow, "Review is exhaustive once, then scoped") limits a re-review to two checks:
- each earlier finding is fixed;
- the files the remediation changed introduced no regression.

Anything else is recorded as MINOR at most. The first review (same file, earlier revision) swept every category. Its coverage is carried forward below and updated where the fixes changed it.

**Files changed by the remediation.** These are the files modified after the first review was written, identified by mtime. I read every one in full:
- `src/server/scheduler/publishing.ts`
- `src/server/services/activity/classify.ts`
- `src/server/services/activity/filters.ts` and `filters.test.ts`
- `src/components/activity/ActivityFilters.tsx` and `ActivityRow.tsx`
- `drizzle/0013_backfill_activity_events.sql`
- `docs/activity.md`
- `tests/integration/activity/{scheduler-events,ui,retention,rollback,backfill}.test.ts(x)`

Also read for this round:
- the context each fix depends on: `src/server/scheduler/recovery.ts` and the `claimDueTargets` diff in `src/server/dal/scheduler.ts`;
- the contract text on `range`: `contracts/ui.md`, `contracts/http-api.md:22`, `research.md:206`, `src/lib/api/schemas.ts:362` and `docs/n8n.md:150`;
- `src/components/shell/UserMenu.tsx`, `src/server/services/activity/links.ts` and the earlier MINOR locations, to check their status.

**Not re-read this round:** the rest of the feature, which the first review covered and the remediation did not touch. Generated files (`drizzle/meta/*`, `icons.generated.ts`) and `.specify/roadmaps/*` were not reviewed.

**Probes run.** I ran targeted tests only, per the constitution's review rule:
- **The 7 suites the remediation touched** (`scheduler-events`, `ui`, `retention`, `rollback`, `backfill`, `filters.test`, `classify.test`): 57 of 57 passed.
- **A wider regression set for the changed `publishing.ts` and `classify.ts`**: `tests/integration/scheduler/*`, `posts/claim-race`, `limits/enforcement`, every `tests/integration/activity/*` suite except `performance`, `api/endpoints/activity` and `security/secret-scan`. All 35 files and 232 tests passed.

I did not re-run the full suite, lint, typecheck, build or the SC-004 performance suite.

## Verdict

All five remediation findings are fixed, and the fixes hold up. Nothing blocks the merge.

| Finding | Fix |
|---|---|
| F1 | An interrupted safe step that is re-leased now writes its "Retrying" event. Three new integration tests cover the ambiguous, interrupted-retry and exhaustion lease-recovery paths. |
| F2 | The filter form keeps the quick range when you submit it. |
| F3 | Rows for deleted posts keep their excerpt. |
| F4 | The docs page now has "What is not recorded" and "Retention" sections. |
| F5 | Over-long links are dropped from `details` in the live writers and in the backfill, so the log can no longer block a valid change. |

Each fix comes with a test that fails without it, and no existing scheduler or activity test regressed.

The F2 fix has one side effect, recorded as MINOR F11: the screens and the API now read a query that has both `range` and `from`/`to` differently.

The earlier MINORs F6–F8 are still open. They are safe to ship and belong in the hardening entry.

Before a human opens the PR, two things are owed:
- The implementation must be committed with explicit paths (NOTE F10). It is still almost entirely uncommitted.
- T063–T065 remain blocked:
  - `pnpm build` from a real checkout;
  - the `docket-ui` skill entry;
  - the browser walk-through and the backfill check against a pre-feature database.

## Findings

Earlier findings, re-checked:

- [x] MAJOR F1 — FIXED. An interrupted safe step that is re-leased now writes one `target_retry_scheduled` event with `interrupted: true`.
      where:  src/server/scheduler/publishing.ts:175-192, src/server/scheduler/publishing.ts:85-97, src/server/services/activity/classify.ts:101-107, tests/integration/activity/scheduler-events.test.ts:117-160
      check:  The re-lease return now builds `leasePatch` and attaches `eventForDecision({ decision: { patch: leasePatch, attempts }, … })`. The classifier returns null for a plain lease: there are no attempts, status is `publishing` and there is no `recovered_retry`. So only the recovery case writes. `recoverExpiredLease` puts `attemptCount` in the patch (`recovery.ts:44`), so the `patch.attemptCount` guard holds. `claimDueTargets` inserts the event in the claim transaction after the attempt rows (`src/server/dal/scheduler.ts:151`).
      tests:  New suite "an interrupted step (expired lease) is logged", with three cases:
              - a may-publish step → `target_ambiguous`;
              - a safe step → `["target_retry_scheduled", "target_published"]`, with `attempt: 1, interrupted: true`;
              - `attemptCount: 99` → `target_failed`, `engine: "interrupted"`.
              Without the fix, the second case would see only `target_published`. The 12 `tests/integration/scheduler/*` suites, including `recovery.test.ts`, still pass.

- [x] MAJOR F2 — FIXED. The filter form carries the active quick range.
      where:  src/components/activity/ActivityFilters.tsx:100, src/server/services/activity/filters.ts:112-118, tests/integration/activity/ui.test.tsx:229-246, src/server/services/activity/filters.test.ts:45-47
      check:  A hidden `range` input is rendered while a range is active. A submit with empty From/To sends `from=&to=`, and `first()` reads those as null, so the range survives a Platform or Account auto-submit and Apply. A non-empty From or To replaces the range on the screens (lenient mode only). This is the option the first review offered.
      tests:  `ui.test.tsx` serializes the rendered form's hidden inputs, changes the platform and parses the result with `parseActivityFilter`. It gets `range: "7d"` back, and it gets `range: null` when a From date is added. The test fails if the hidden input is removed. See F11 for the side effect.

- [x] MAJOR F3 — FIXED. Deleted-post rows keep their excerpt.
      where:  src/components/activity/ActivityRow.tsx:71-75, tests/integration/activity/ui.test.tsx:72-82, tests/integration/activity/retention.test.ts:25-27
      check:  The row renders "Post deleted · {excerpt}" without a link when the excerpt is non-empty (D9).
      tests:  The UI fixture now uses `excerpt: "Autumn sale"` and asserts it. The retention test asserts `excerpt: "Hello"` after `deletePost`.

- [x] MAJOR F4 — FIXED. `docs/activity.md` now covers FR-026's "not recorded" and retention content.
      where:  docs/activity.md:28-36
      check:  "What is not recorded" covers no publish content beyond an excerpt, no secrets and no engagement metrics. "Retention" says events are kept until the project is deleted, with no expiry and no edits. It gives about 0.5 KB per event, so 100,000 ≈ 50 MB, matching data-model §1, and says date filters are index-backed.

- [x] MINOR F5 — FIXED (promoted to must-fix as T070). Long links can no longer abort the event insert, and with it the state change.
      where:  src/server/services/activity/classify.ts:26-29, src/server/services/activity/classify.ts:59, src/server/services/activity/classify.ts:144, drizzle/0013_backfill_activity_events.sql:28-31, tests/integration/activity/rollback.test.ts:107-139, tests/integration/activity/backfill.test.ts:88-101
      check:  `fitUrl` keeps a link only when it is at most 1,900 *bytes*. That is stricter than the 2,000-character Zod cap in `details.ts:6` and leaves room under the 2,000-byte `details` CHECK. The rule is applied in `eventForStep` (published) and `resolvedEvent` (marked published). The backfill applies the same rule with `octet_length(external_url) <= 1900`. The target's own `external_url` is untouched.
      tests:  Three new tests:
              - `recordStepResult` with a 2,000-character link commits, keeps the target's URL and writes an event without `url`;
              - resolve with a 2,048-character link succeeds;
              - the backfill over a 2,048-character `external_url` completes.

- [ ] MINOR F6 — STILL OPEN. Backfilled needs-reauth events always claim `reason: "renewal_refused"`.
      where:  drizzle/0013_backfill_activity_events.sql:51, tests/integration/activity/backfill.test.ts:61, tests/integration/activity/backfill.test.ts:84
      why:    The remediation edited this file (for F5) and left this unchanged. An account flagged through "credentials invalid" is backfilled with a cause the backfill cannot know, and the API returns that cause in `details.reason`.
      owed:   Make `reason` optional when `backfilled` is set and omit it in `0013`, or derive it from a stored column if one records the cause.
      traces: FR-011, D10, FR-024

- [ ] MINOR F7 — STILL OPEN. Link labels differ from the spec and the docs.
      where:  src/components/shell/UserMenu.tsx:31-32, src/server/services/activity/links.ts:20, docs/activity.md:8, docs/activity.md:53
      why:    Two labels disagree:
              - The user-menu link reads "Activity". The spec, `contracts/ui.md` and `docs/activity.md:8` say "All activity". On project pages it sits next to the left-nav "Activity", which goes somewhere else, so two links share a name but lead to different places (WCAG 2.4.4).
              - Account rows say "Go to accounts", while the docs (rewritten in T069, `:53`) say "Open accounts".
      owed:   Rename the links to "All activity" and "Open accounts".
      traces: FR-019, FR-014

- [ ] MINOR F8 — STILL OPEN. Several FR-027 test obligations are thin or test something else.
      where:  tests/integration/activity/scheduler-events.test.ts:95-99, tests/integration/activity/ui.test.tsx:55-63, tests/integration/api/endpoints/activity.test.ts:107, tests/integration/security/secret-scan.test.ts:410
      why:    The gaps the first review listed, minus the lease-recovery gap that F1's tests closed:
              - (a) "a deferral writes no event" ticks before the slot, so nothing is claimed;
              - (b) there is no G15 publish-time validation case;
              - (c) only 3 of the 7 badges are asserted;
              - (d) "revoked key" sends a malformed key;
              - (e) the secret scan reads stored rows only.
      owed:   As in the first review:
              - make the deferral case really defer;
              - add a G15 case;
              - render all seven badges;
              - revoke a real key;
              - scan one rendered page and one API response.
      traces: FR-027, SC-006, US6 AS5

New this round. Under the re-review rule this is MINOR at most:

- [ ] MINOR F11 — Since T067, the screens and the API read `range` together with `from`/`to` differently.
      where:  src/server/services/activity/filters.ts:112-114, src/server/services/activity/filters.test.ts:45-47, src/lib/api/schemas.ts:362, docs/n8n.md:150, specs/020-activity-history/research.md:206
      why:    There are two consequences:
              - **The same query gives different results.** On the screens, a non-empty From or To now clears an active range (lenient mode). The API keeps the documented rule that the range overrides the dates (strict mode). After someone types a date while "7 days" is active, the browser's address bar holds `…&range=7d&from=2026-10-01&to=`. The screen shows everything since 2026-10-01, but the API given the same parameters returns the last 7 days. FR-023 and US6 AS2 say the API applies the filters "exactly as the screen does", and research P12 says the range wins over the dates. The behaviour is deliberate and tested, but no `docs/decisions.md` entry records it. Canonical links (`filterToSearchParams`) never emit both, so shared in-app links are unaffected.
              - **No way back to "All time" except Clear filters.** While a quick range is active, Clear filters is now the only way back to "All time", and it also drops the platform, account and outcome filters. Before T067, Apply dropped the range by accident. The contract defines no "All time" option, so this is a usability note, not a contract break.
      owed:   Pick one of these, and record the choice in `docs/decisions.md` (020):
              - make strict mode follow the same "typed dates replace the range" rule;
              - have the API reject `range` together with `from`/`to` as `validation_failed`;
              - normalize the screen's URL with a redirect to the canonical query after a form submit.
              Optionally, add an "All time" quick-range link that clears the range and keeps the other filters.
      traces: FR-015, FR-023, US6 AS2, T067

- NOTE F9 — The writer helpers are still used inconsistently. `recordTargetEvent` and `recordConnectFailed` (`src/server/services/activity/record.ts:17`, `:34`) exist, but other sites call `activity.insert` directly: `src/server/scheduler/record.ts:151`, `src/server/services/connect.ts:335`, `src/server/services/connect.ts:408`, and now the claim path at `src/server/dal/scheduler.ts:151`. This is harmless, because every route inserts in the same transaction.

- NOTE F10 — The implementation is still uncommitted. `git status` shows 43 modified and 49 untracked files. That includes all of the following:
  - `src/server/services/activity/` and `src/server/dal/{activity,my-projects}.ts`;
  - both migrations;
  - the routes, the components and the writer edits;
  - the new test suites.

  Only `0942716` (the performance test and docs) and the spec artifacts are committed. The constitution requires commits per task with explicit paths, so these must be committed before a PR is opened. Nothing is lost.

## Coverage

These counts carry the first review's sweep forward, updated for this round's fixes. This round re-checked 8 earlier findings and found 1 new one.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier findings re-checked (F1–F8) | 8 | 5 fixed (F1–F5) | 3 open MINOR (F6–F8) | 0 | 0 |
| Functional requirements (FR-001–FR-027) | 27 | 26 | 1 (FR-027, MINOR F8) | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 8 | 0 | 0 | 0 |
| User stories (US1–US6) | 6 | 6 | 0 | 0 | 0 |
| Spec decisions (D1–D10) | 10 | 10 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |

Notes on the counts:
- **FR-003, SC-002, D2 and US5** move to satisfied because of F1. **FR-008, D9 and US1** move because of F3, **FR-015 and US2** because of F2, and **FR-026** because of F4.
- **FR-011, FR-019 and FR-023** are satisfied with MINOR caveats (F6, F7, F11).
- **FR-010** is satisfied but does not apply: a stored table was chosen, not a derived view.
- **SC-004** is carried from the first review, which ran the suite alone: under 1 s for 100k events in one project and 200k across 20 projects. It was not re-run this round. The implement pass reports that it passes alone, and that it ran 1,077 ms in one run where other suites ran in parallel. The remediation did not touch the query or index path.

## What I could not check

- **`pnpm build`** (T063, blocked). Turbopack refuses the worktree's `node_modules` symlink. The routes and the `searchParams` handling are covered by `tsc` in the implement pass only.
- **A browser walk-through** (T065, quickstart §3). Not checked:
  - the real form submit in a browser after F2: auto-submitting `ChoiceField`s, the hidden `range` field and native date pickers;
  - keyboard focus order and visual layout;
  - the switcher's arrow-key behaviour with the new item.
  The F2 test serializes rendered markup, not a live form.
- **The backfill against a real pre-feature database** (T065, quickstart §5): runtime on large tables, and production-shaped `last_error` and `external_url` values.
- **SC-004 this round, and on production hardware or Neon.** It was not re-run, and it has only ever run on local Postgres.
- **SC-001 with a person.** The "under 10 seconds" target was not timed.
- **Live OAuth, paste and credential connects.** These were verified with mocked HTTP only, per the constitution.
- **The `docket-ui` skill entry** (T064). `.claude/skills/docket-ui/SKILL.md` is outside the pipeline's write scope, and the operator still owes its "Activity" Structure entry.
- **The full suite, lint, typecheck and build.** I did not re-run these, per the constitution's review rule. Only the 35 targeted test files listed above were run.
