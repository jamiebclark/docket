# Review: Problem notifications — an unread-problems bell, a recent-problems panel and a per-project callout

**Round 2: re-review after remediation.** Following the constitution's review rule, this round checks only two things: that each round-1 finding is fixed, and that the files the remediation changed did not break anything. Anything else is recorded as MINOR or NOTE, not as BLOCKER or MAJOR.

Reviewed against `9e9ac5f...HEAD`: 92 files changed across 16 commits, all committed. `git status` is clean. The remediation is `15c577a..HEAD`: 19 files across 8 commits (`b9a1558`, `878b3e0`, `7a9d0f4`, `2b3d6cc`, `88e20af`, `e7da478`, `fe153e3`, `c8b39e9`).

- **Read in full (the whole remediation diff):**
  - `src/app/notifications/{page.tsx,actions.ts}`
  - `src/app/p/[projectSlug]/settings/{page.tsx,actions.ts}`
  - `src/app/p/[projectSlug]/activity/page.tsx`, `src/app/activity/page.tsx`
  - `src/components/notifications/{NotificationList,NotificationPanel,NotificationsChanged,ProblemsCallout,NotificationToggle}.tsx`, `src/components/notifications/{focus,request,poll}.ts`
  - `src/lib/notifications/text.ts`
  - `tests/integration/notifications/{ui.test.tsx,mute.test.ts,view-mark.test.ts}`
  - the diffs of `docs/activity.md` and `docs/design-system.md`
- **Read for cross-checks:**
  - `src/server/services/notifications/panel.ts`
  - `recordPlatforms`/`recordAccount` in `src/server/services/activity/index.ts:78-90`
  - the `activity_events_provider_keys` CHECK in `src/server/db/schema/activity.ts:58-59`
  - `src/components/ui/Alert.tsx:35`
  - `src/server/dal/my-projects.ts:84-99`
  - `tests/integration/notifications/{routes,performance}.test.ts`
  - `commitlint.config.mjs`
  - implement's final report in `.pipeline/implement.result.json`
- **Not re-read:** the round-1 code that remediation did not touch (DAL, locking, migrations, services, routes). Round 1 read all of it in full, and this round's rule does not reopen it.
- **Probes run:**
  1. `pnpm vitest run` on `ui.test.tsx`, `mute.test.ts`, `view-mark.test.ts` and `mark-all.test.ts`: **45 of 45 passed**.
  2. The two performance suites, together and then alone, with the machine's load average at about 140. Results are under F11.
  3. `commitlint --from 9e9ac5f --to HEAD`: exit 0.
4. 020's `tests/integration/activity/performance.test.ts` on an export of the base commit `9e9ac5f`, then on this branch straight after. **Both passed.** That rules out 022 as the cause of the 1.7 s "platform" timing I saw earlier in probe 2: it was machine load.

I did not re-run the full suite, lint, typecheck or build, per the constitution.

## Verdict

**The feature now meets its spec, and the remediation hangs together. Nothing blocks the merge.**

All three blocking findings from round 1 are fixed:

- **F1, uncommitted work.** It is committed as small Conventional Commits.
- **F2, no-JS "Mark all as read".** `/notifications` now has the form and both confirmations, and a test covers them.
- **F3, "Removed account" on connect failures.** An event with no account no longer shows that label, and the test now separates the two cases.

The five MINOR findings that were promoted to tasks are also fixed, each with a test: F4, F5, F6, F7 and F10. Remediation added one small new defect, F16: the `?busy=` confirmation repeats whatever text is in the query string. It is safe to ship.

What is still open is non-blocking:

- two narrowed round-1 MINORs (F8 test gaps, F9 a duplicated form);
- the panel's 100 ms timing (F11), which now has evidence of failing under load. Expect it to be the likeliest red test when CI first runs. It is the plan's panel budget, not SC-003's count or refresh, which passed in every run.

**What to do:** push and let CI run the full suite. The branch has no upstream yet, so CI has never run on this code. If CI fails on `performance.test.ts:113`, deal with F11. Then a human does the browser walk-through (T052) and the docket-ui skill edit (T053), and merges.

## Round-1 findings: status

| Round 1 | Severity | Status | Evidence |
|---|---|---|---|
| F1 implementation uncommitted | BLOCKER | **Fixed** | `44e5640`, `34cc321`, `5cb90aa`, `af050a9`, `15c577a` and 7 remediation commits. Tree clean. `commitlint --from 9e9ac5f --to HEAD` exits 0 (`commitlint.config.mjs:2`). |
| F2 no-JS "Mark all as read" | MAJOR | **Fixed** | `src/app/notifications/page.tsx:66-79`: the form, hidden `returnTo`, shown only when `unread.count > 0`. `:33-34` and `:58-62`: the `marked`/`busy` confirmations in the contract §4 wording. `src/app/notifications/actions.ts:33`: the redirect. Tests: `tests/integration/notifications/ui.test.tsx:147-166`. |
| F3 connect failure labelled "Removed account" | MAJOR | **Fixed** | `src/components/notifications/NotificationList.tsx:29` renders the account segment only when `accountName !== null`. `panel.ts:19` and `services/activity/index.ts:82-90` still supply "Removed account" for a real removed account. `providerKeys` has cardinality ≥ 1 (`schema/activity.ts:59`), so the line never starts with a stray " · ". Tests: `ui.test.tsx:86-108`. |
| F4 failed mute/unmute silent | MINOR → T057 | **Fixed** | `src/app/notifications/actions.ts:42-51` and `src/app/p/[projectSlug]/settings/actions.ts:47-57` redirect with `busy`, `not_found` or `invalid`. `page.tsx:56` and `settings/page.tsx:52` render a danger `Alert`, which is `role="alert"` (`Alert.tsx:35`). Tests: `mute.test.ts:108-137`, `ui.test.tsx:182-201`. |
| F5 bell stale after a soft navigation to Problems | MINOR → T058 | **Fixed** | `src/components/notifications/request.ts:14-29` returns `true` only after a mark. `src/app/p/[projectSlug]/activity/page.tsx:54` and `src/app/activity/page.tsx:46` render `NotificationsChanged`. Its effect dispatches `CHANGED_EVENT` (`NotificationsChanged.tsx:8-10`), and the poller refreshes on it (`poll.ts:64`, `:87-89`). Tests: `view-mark.test.ts:105-121`. |
| F6 focus lost after mark | MINOR → T059 | **Fixed** | `src/components/notifications/NotificationPanel.tsx:52` focuses the `tabIndex={-1}` heading (`:98`). Test: `ui.test.tsx:263-271`, which tests the helper only (see F8). |
| F7 callout title and wording | MINOR → T060 | **Fixed** | `src/components/notifications/ProblemsCallout.tsx:17-21` reads "Problems since you last looked", then "N problems in {project}. View problems", as in contracts/ui.md §6. Tests: `ui.test.tsx:226-249`. |
| F8 test gaps (route auth cases, page wiring) | MINOR | **Partly fixed**; carried below | — |
| F9 duplicated event name and toggle form | MINOR | **Partly fixed**; carried below | — |
| F10 docs: bell position, FR-022 sentence | MINOR → T061 | **Fixed** | `docs/design-system.md:189`, `docs/activity.md:69` |
| F11 panel budget has little margin | NOTE | **Open, now evidenced**; raised to MINOR below | — |
| F12, F13 | NOTE | Unchanged; carried below | — |
| F14 full suite not re-run | NOTE | Superseded; updated below | — |
| F15 T052/T053 owed to a human | NOTE | Unchanged; carried below | — |

## Findings

- [ ] MINOR F16 — The `/notifications` "Mark all as read" confirmation repeats any text from `?busy=`, and splits project names on commas
      where:  src/app/notifications/page.tsx:34, src/app/notifications/page.tsx:60, src/app/notifications/actions.ts:33
      why:    **Forged text.** The page prints `raw.busy` into a success-tone `Alert` without checking it. So a link like `/notifications?marked=1&busy=<any words>` shows "Marked as read. Could not mark <any words> as read; try again." on a real Docket page. React escapes the text, so no script runs. It is still spoofed content. The neighbouring `?changed=` handles this correctly: it looks the slug up among the caller's own projects (`page.tsx:35`), so it cannot be forged.
              **Commas.** The action joins project *names* with "," (`actions.ts:33`), and the page splits on ",". `projectNameSchema` (`src/lib/validation/name.ts:9`) allows commas, so a busy project named "Acme, Inc" comes back as "Acme,  Inc", with a double space.
              This was added by T055 and is the only defect I found in the remediation.
      owed:   Carry project slugs in `busy` (the service already knows the ids, `services/notifications/index.ts:42-48`). On the page, look them up among `states` the way `changed` does, and drop unknown ones. Add a `ui.test.tsx` case that a forged `busy` value is not shown, and that a name containing a comma round-trips.
      traces: contracts/ui.md §4 (confirmations), FR-014

- [ ] MINOR F11 — The panel's 100 ms timing fails under load, so `performance.test.ts` is the most likely red test on the first CI run
      where:  tests/integration/notifications/performance.test.ts:113, tests/integration/notifications/performance.test.ts:135, src/server/dal/activity.ts:242
      why:    **Implement's run.** In its final pass, the full `pnpm test` failed "answers under 100 ms at 200k events across 20 projects, 5 of them muted". It passed when re-run alone.
              **My probes.** With 020's performance suite running in parallel, `recentPanel` took 102 ms at 100k events and 168 ms at 200k. Run alone at load average ~140, it took 104 ms at 200k. Round 1's run alone passed.
              **What never failed.** The `unreadSummary` and refresh-handler assertions (`:111-112`) passed in every run. SC-003 only budgets those two. The panel's 100 ms comes from the plan's Performance Goals.
              The assertion is right about the plan, but it has no margin. GitHub's runners are smaller than this machine, so CI may go red, or flake, on the first push.
      owed:   If CI fails on `:113`, choose one:
              (a) give the panel its own budget, with the plan's Performance Goals updated to match, and keep 100 ms for count and refresh; or
              (b) tighten `listAttention`'s per-branch plan (four branches × 20 projects).
              Do not loosen `:111-112`.
      traces: plan.md Performance Goals, SC-003 (count and refresh: satisfied)

- [ ] MINOR F8 — Test integrity: the refresh's "expired session" and "API key" cases still only test the mocked no-session case. The `/activity` page's wiring and the panel's focus wiring are not rendered.
      where:  tests/integration/notifications/routes.test.ts:28-30, tests/integration/notifications/view-mark.test.ts:88-91, tests/integration/notifications/ui.test.tsx:263-271, src/components/notifications/NotificationPanel.tsx:52
      why:    **Narrowed.** `view-mark.test.ts:113-121` now renders the project Activity page and checks that the refresh leaf appears exactly when the page marks read.
              **Still open:**
              - `routes.test.ts:28-30` is `actAs(null)` plus a Bearer header, so the handler never sees the header. There is still no real expired Better Auth session (FR-023: "none, expired, API key").
              - `src/app/activity/page.tsx` and the header count rendered in the same request are still not exercised through the page.
              - The F6 test calls `focusAfterMark` with a stub. Its `false` branch is never used in production, because the only caller passes `true` (`NotificationPanel.tsx:52`). The wiring itself has no test.
              The behaviour is right by construction. These are regression guards that are missing.
      owed:   Add an expired-session case through the real `getSession` with a past `expires_at`. Render `src/app/activity/page.tsx` under the `next/headers` mock and check the leaf and the in-request count. Optionally drop `focusAfterMark`'s unused parameter.
      traces: FR-023, FR-015, FR-006, FR-013

- [ ] MINOR F9 — The "Your notifications" settings form is still a hand-copied `NotificationToggle`
      where:  src/app/p/[projectSlug]/settings/page.tsx:58-70, src/components/notifications/NotificationToggle.tsx:7-19
      why:    **Narrowed.** The event name now has one definition (`src/components/notifications/poll.ts:4`), imported by `NotificationPanel.tsx:11` and `NotificationsChanged.tsx:4`.
              **Still open.** The two on/off forms repeat the same hidden fields, button copy and sr-only name. They differ only in the action, so they can drift in copy or accessible name.
      owed:   Give `NotificationToggle` an `action` prop (or a settings variant) and use it on the settings card.
      traces: Constitution IV

- NOTE F12 — Carried from round 1. The Activity filter's own "Problems" tab is a `Link` with the default prefetch (`src/components/activity/ActivityFilters.tsx:53` → `src/components/ui/FilterTabs.tsx:15`). What stops a prefetch from marking is the header guard (`src/components/notifications/request.ts:17`), and it is tested (`view-mark.test.ts:81-85`, `:110`). This is defence in depth, not a defect.
- NOTE F13 — Carried from round 1. `recent()` filters mutes from the resolved set only (`src/server/dal/my-projects.ts:84`, `:99`). Unlike `countUnread` (`src/server/dal/notifications.ts:79`), its SQL does not re-check `muted = false`, and it includes projects with no state row. Both gaps are reachable only by a mute committed mid-request, or by a membership written outside the DAL.
- NOTE F14 — Updated. Implement's final full `pnpm test` had three failures, each passing when re-run alone:
  - `tests/integration/notifications/performance.test.ts` (F11);
  - 020's `tests/integration/activity/performance.test.ts` ("platform", about 1.7 s against 1 s);
  - `tests/integration/failures/retry-all-cap.test.ts`.

  My back-to-back run of 020's suite on base `9e9ac5f` and on this branch passed on both, so that timing is machine load, not 022. `retry-all-cap` touches no notification code. `tsc` was clean and eslint showed warnings only. The branch has no upstream (`git branch -vv`), so **CI has never run on this code**.
- NOTE F15 — Carried. T052, the manual browser walk-through (quickstart §5), and T053, the `.claude/skills/docket-ui/SKILL.md` Structure list, are 🛑 BLOCKED and owed to a human. They are correctly unticked. T053 is the last missing part of FR-022.
- NOTE F17 — The seven remediation commits (`878b3e0`…`c8b39e9`) end with `Co-Authored-By: Claude Sonnet 5.5`, which names the model that wrote them. The constitution's Development Workflow spells the trailer `Claude Opus 5.5`. commitlint does not check trailers (`commitlint.config.mjs:1-8`), so nothing will fail. I treat this as accurate attribution, not a defect. It is recorded in case the owner wants the literal string.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-023) | 23 | 21 | 2 (FR-022: skill list owed, T053/F15; FR-023: F8) | 0 | 0 |
| Success criteria (SC-001–SC-007) | 7 | 7 | 0 | 0 | 0 |
| User stories (US1–US7) | 7 | 7 | 0 | 0 | 0 |
| Plan decisions (R1–R17) | 17 | 16 | 1 (R9: F12) | 0 | 0 |
| Constitution principles and constraints (I–VII, Neon pooler, scheduler, UTC/Temporal, accessibility, commits, docs) | 13 | 12 | 1 (IV: F9) | 0 | 0 |

**Changes from round 1:**

- **Now satisfied:** FR-011 (F3), FR-014 and SC-007 (F2), US2, R13 (F2), R15 (F7), the docs constraint (F10) and commits (F1).
- **IV now counted as partial.** Round 1 counted it as satisfied while F9 was open; I count it partial for honesty. That is a reclassification, not a regression.
- **SC-003 is satisfied.** It budgets only the count and the refresh, which passed in every run. The plan's separate panel budget is F11.

## What I could not check

- **Anything in a browser.** That includes:
  - the F5 fix as real soft navigation: a layout's bell refetching when `NotificationsChanged` mounts;
  - focus actually landing on the panel heading after "Mark all as read" (F6);
  - the no-JS "Mark all as read" round trip through a real form post and redirect (F2);
  - the 60 s refresh;
  - whether Next 16.3.8's real prefetch requests carry the headers the guard expects.

  The tests check element trees and pure helpers, because the suite has no DOM. All of this is T052, owed to a human.
- **CI.** The branch has never been pushed, so neither the full suite on CI hardware nor the Docker image build has run. F11 is the likeliest failure.
- **Timing on a quiet machine.** Every timing probe ran at load average 130–140, with other sessions active. The numbers in F11 show the panel has no margin, but not how it behaves on CI.
- **Lock contention under production load,** and **migration 0015's non-concurrent index build** on a large `activity_events`. Both are unchanged since round 1 and still unmeasured.
- **`.claude/skills/docket-ui/SKILL.md`.** It is outside this phase's write and review scope (T053).
