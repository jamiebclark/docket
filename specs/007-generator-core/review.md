# Review: Generator core (LLM layer, voice profiles, single and series generation, approval policy, review queue)

**This is a re-review after remediation.** The constitution ("Review is exhaustive once, then scoped") limits it to two questions:

1. Is each earlier finding fixed?
2. Did the files the remediation changed introduce a regression?

It opens no new lines of inquiry. Anything new it noticed is recorded as MINOR for the hardening entry.

**What the feature is:** 167 files changed across 17 commits, `8b634cd..01cfba1`, merged to `main` as `7244e21` (PR #12). The first review read the working tree, because most of the work was uncommitted then (F3). This pass reads the committed state at `main` HEAD `69cff5d`.

**Read in full:**

- `src/server/services/generation/regenerate.ts` (F1 fix)
- `tests/integration/generation/regenerate.test.ts`
- `src/app/p/[projectSlug]/generate/result/[postId]/{page,VariantEditor}.tsx` (F2 fix)
- `src/app/p/[projectSlug]/generate/result/result.test.tsx`
- `src/server/services/generation/policy.ts:23-37` (`decidePolicy`)
- `src/server/services/review.ts:150-215` (approve with edits)
- `src/app/p/[projectSlug]/review/ReviewList.tsx:20-185` (the other caller of `VariantEditor`)
- the 007 section of `docs/decisions.md`

**Sampled:**

- `git log 8b634cd..01cfba1`, commit messages and trailers (F3)
- `series.ts`, `review.ts:120-123`, `core.ts`, `prompt.ts` and `GenerateForm.tsx`, by grep, for the status of F4–F10
- `git show 337e0ed -- regenerate.ts`

**Not reviewed** (outside a scoped re-review): later commits on `main` that touch generator files. These are `337e0ed` (refactor into `runGenerationStep`/`save.ts`), `6072ac7` and `1533054`. Each belongs to a later entry (008/009/010) and was reviewed there.

**Executed:** `pnpm vitest run tests/integration/generation/regenerate.test.ts 'src/app/p/[projectSlug]/generate/result/result.test.tsx' tests/integration/generation/policy-matrix.test.ts tests/integration/review`. Result: 5 files, 40 tests, all passed at HEAD. Per the constitution, I did not re-run the full suite, lint, typecheck or build.

## Verdict

**All three blocking findings from the first review are fixed. Nothing blocks.**

- **F1:** `regeneratePost` now gets its review state from `decidePolicy`. Under `review_required`, a human-approved post returns to `needs_review`. The test that asserted the old behaviour now asserts the fix.
- **F2:** `VariantEditor` fetches counts on mount, so the result screen shows `used / limit` without an edit.
- **F3:** the feature was committed as 15 scoped Conventional Commits with the trailer and merged.

The remediation brought one small regression: in the review queue, the mount-time fetch re-runs whenever the list re-renders, and it can overwrite the count for edited text (F14). Two parts of what F1 and F2 owed were also not done: the test for F2 (F15), and the documented decision on regenerating a rejected post (F16). All three are MINOR, because the server's approval check still refuses invalid content.

MINOR findings F4–F10 from the first review are still open. They are hardening-entry material, and 010 already picked up F6 as its FR-005.

The feature is ready as merged. `tasks.md` is unchanged by this review.

## Findings

- [x] MAJOR F1 — Regenerate bypassed the single approval-policy service and left new content approved. **Resolved.**
      where:  src/server/services/generation/regenerate.ts:141-162, tests/integration/generation/regenerate.test.ts:71-84
      why:    `regeneratePost` now calls `decidePolicy` with `previous.policies.resolved.approval`, `scheduling: "leave_as_draft"` and the gate's blocking messages, and writes that `reviewState`. With validation blocking, the `decidePolicy` code at policy.ts:28-31 returns `needs_review` (or under `review_required`). It returns `approved` only for `auto_approve` with nothing blocking, and the result never queues (`queued: false`). The test now sets the post to `approved`, regenerates, and expects `needs_review` with "Review required by policy", for both valid and invalid output. The test passed in this run.
      traces: FR-022, FR-024, constitution IV

- [x] MAJOR F2 — The result screen showed no `used / limit` counts until an edit. **Resolved** (see F14 and F15 for gaps).
      where:  src/app/p/[projectSlug]/generate/result/[postId]/VariantEditor.tsx:39-49
      why:    When no `initialCheck` is given, a mount effect calls `fetchCheck` with the server texts, so counts and issues appear after the first client render. On the result page, `cards` and `mediaIds` are server-component props and stay stable between client renders, so the effect runs once per page load (and again after `router.refresh()` with the saved text).
      traces: US1 acceptance scenario 1, FR-033

- [x] MAJOR F3 — Most of the feature was uncommitted, and HEAD did not compile. **Resolved.**
      where:  git log 8b634cd..01cfba1 (e.g. ad150d6, adf9e56, 1afaf71, 276e4de, 5fda0e2, a54ee60, 78e84e0, 2bef822)
      why:    The work landed as 15 scoped commits plus the spec and plan:
              - db; dal; llm; voice; policy; generation; screens; review; nav; auth; tests; docs;
              - each with the `Co-Authored-By` trailer (checked on 5fda0e2, 276e4de, adf9e56);
              - merged as PR #12 with CI.
      traces: constitution Development Workflow

- [ ] MINOR F14 — In the review queue, an open editor's counter falls back to the original text's count whenever the list re-renders.
      where:  src/app/p/[projectSlug]/generate/result/[postId]/VariantEditor.tsx:49, src/app/p/[projectSlug]/review/ReviewList.tsx:155-167, src/app/p/[projectSlug]/review/ReviewList.tsx:84-87
      why:    The F2 effect depends on `cards`. `ReviewList` builds `cards` inline with `item.variants.map(...)` and passes no `initialCheck`, so every `ReviewList` render gives a new array and re-runs the effect. The effect fetches counts for the **original** `cards` texts, not the edited `texts` state, and `setCheck` replaces the current result. To reproduce:
              1. Open Edit on a post.
              2. Type until the counter shows "(too long)".
              3. Tick another post's checkbox (`setSelected`), or let an Approve elsewhere update `message` or `pending`.
              4. The counter now shows the original text's count with no "too long", even though the textarea still holds the over-long text.
            The next keystroke corrects it. "Save and approve" still refuses invalid content on the server (review.ts:189-201), so nothing wrong is approved. The responses also have no ordering guard, so a slow mount fetch can land after a debounced one.
      owed:   Make the mount fetch run once per post, keyed on `postId` (or a ref set after the first fetch), and build its input from the current `texts`. Alternatively, have `ReviewList` pass the server-built counts it already has as `initialCheck`. Ignore responses from fetches older than the latest edit.
      traces: FR-033, US3 (edit then approve)

- [ ] MINOR F15 — The F2 fix has no test. T081 asked for a render assertion of the count on the result page.
      where:  src/app/p/[projectSlug]/generate/result/result.test.tsx:65-72
      why:    The page test renders with `renderToStaticMarkup`, which never runs effects, so it cannot see the mount fetch. It still asserts only the decision, text, regenerate and details. The "variant editor checks" block tests `cardCheck` and the debounce, not the mount fetch. Removing the effect at VariantEditor.tsx:39-49 would leave every test green.
      owed:   Add a client render test (jsdom with an injected `fetchCheck`) that mounts `VariantEditor` without `initialCheck` and expects `n / limit` without any input. Or compute the check on the server in the result page and assert it in the static markup.
      traces: US1 acceptance scenario 1, T081

- [ ] MINOR F16 — Regenerating a `rejected` post is still allowed and still undocumented, and under `auto_approve` it re-approves the post.
      where:  src/server/services/generation/regenerate.ts:52-59, src/server/services/generation/regenerate.ts:144-161, docs/decisions.md:307
      why:    F1 owed "decide and document whether a `rejected` post can be regenerated". The code does not check `reviewState`, so a rejected post is regenerated:
              - under `review_required` it becomes `needs_review`, which is reasonable;
              - under `auto_approve` it becomes `approved` with no human action beyond Regenerate, which reverses a reviewer's explicit reject.
            `docs/decisions.md` records only "Regenerate replaces content even if edited meanwhile". The result page also still labels a rejected post "In review" (page.tsx:55), see F10. Regenerate also leaves the earlier `reviewedAt`/`reviewedByUserId` set when it moves a post back to `needs_review`. Nothing displays those fields today.
      owed:   Choose one rule: refuse regenerate on `rejected`, or always send a regenerated rejected post to `needs_review` whatever the policy. Then add a test and a `docs/decisions.md` entry with how to reverse it.
      traces: FR-022, FR-024, Story 3 (reject)

- [ ] MINOR F4 — Still open. `planSeries` makes a model call before `resolvePolicies` refuses the request.
      where:  src/server/services/generation/series.ts:80, src/server/services/generation/series.ts:165
      why:    Unchanged. `resolvePolicies` is still called only in `startSeries`.
      owed:   As in the first review: call `resolvePolicies` at the top of `planSeries`.
      traces: FR-026, FR-027, Story 4 scenario 5

- [ ] MINOR F5 — Still open. `writeSeriesPost` and `getSeries` do not parse their ids or position with Zod.
      where:  src/server/services/generation/series.ts:206-215
      why:    Unchanged. `position: number` is used directly as `angles[position]`.
      owed:   As in the first review.
      traces: FR-023

- [ ] MINOR F6 — Still open in 007. The navigation badge loads up to 50 post rows to count them.
      where:  src/server/services/review.ts:120-123
      why:    Unchanged. Spec 010 FR-005 cites this finding.
      owed:   A count-only query.
      traces: plan Performance Goals

- [ ] MINOR F7 — Still open. There are dead ends and a duplicated retry set.
      where:  src/server/services/generation/prompt.ts:229, src/server/services/generation/core.ts:33-34, src/server/services/generation/core.ts:59, src/server/services/generation/series.ts:78
      why:    `describeProblems` is still unused and `warnings` is still never shown. `RETRYABLE` is still defined twice with the same members.
      owed:   As in the first review.
      traces: FR-015, SC-004

- [ ] MINOR F8 — Still open. "Save and approve" edits have no length cap.
      where:  src/server/services/review.ts:22
      why:    Unchanged: `text: z.string()`.
      owed:   Use `baseTextSchema`.
      traces: FR-022, FR-030

- [ ] MINOR F9 — Still open. A thrown policy error after the save replaces the `requestId`, so a retry duplicates the post.
      where:  src/app/p/[projectSlug]/generate/GenerateForm.tsx:151
      why:    Unchanged.
      owed:   As in the first review.
      traces: Edge case "Double submit"

- [ ] MINOR F10 — Still open. The result page shows unrounded latency, labels a rejected post "In review", and shows stale problems.
      where:  src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:55, src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:56, src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:119
      why:    Unchanged. `log.ts:19` rounds latency for the log line only.
      owed:   As in the first review.
      traces: FR-033

- NOTE F11 — Carried from the first review. Bulk approve approves a post that has no posting slots and leaves it unscheduled with a message (review.ts:245-269). Owner confirmation is optional.
- NOTE F12 — Carried. `generate/page.tsx` lists profiles through the scope repository rather than the service.
- NOTE F13 — Carried. Live latency (T079, FR-037) is unmeasured, and `docs/decisions.md:292` says so. This is correct for a run without a key.
- NOTE F17 — T080–T082 are still unticked on `main` (tasks.md:300-302), although the work is done. They are ticked by `18981ed` on the unmerged `chore/review-bookkeeping` branch. This review does not re-tick existing tasks. Merging that branch closes them.

## Coverage

The counts are the first review's full sweep, updated with this pass's re-verification of F1–F3.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-037) | 37 | 37 | 0 | 0 | 0 |
| Success criteria (SC-001–SC-011) | 11 | 10 | 0 | 0 | 0 (SC-001 is human timing, not measurable here) |
| User stories (acceptance scenarios) | 6 | 6 | 0 | 0 | 0 |
| Constitution principles and constraints (I–VII, no call in a held transaction, UI via docket-ui, commit workflow) | 10 | 10 | 0 | 0 | 0 |
| Earlier findings re-checked | 10 (F1–F10) | 3 fixed | 0 | 7 still open (all MINOR) | 0 |

FR-022, FR-024, US1 scenario 1, constitution IV and the commit workflow moved from Partial to Satisfied on this pass's evidence: the F1, F2 and F3 entries above and the 40 passing tests. The other rows are carried from the first review and were not re-derived, per the scoped re-review rule.

## What I could not check

- **Client behaviour of the F2 fix and F14** in a real browser. Static markup cannot run effects. F14 is derived from React's effect-dependency semantics and the inline `cards` array at ReviewList.tsx:158. No test reproduces it.
- **Live providers and real latency** (T079). There is no key or network in this phase.
- **SC-001** ("under 2 minutes from Generate to a saved post") is a human-timing measure.
- **Full gates** (lint, typecheck, full suite, build, `db:check`, Docker image) were not re-run, per the constitution. CI ran them on PR #12 before the merge.
- **The post-merge generator changes** in `337e0ed`, `6072ac7` and `1533054`. They are outside a scoped 007 re-review and belong to the later entries' reviews.
