# Review: Accounts restructure and first-post flow (033)

I reviewed 53 non-spec files: 38 modified and 15 new (untracked), against `d830752...` plus the working tree. The
branch's 2 commits (`bc30999` spec, `991915f` plan) are docs only. **All implementation is uncommitted**, so this is a
review of the working tree against the merge base `d830752`, not of a commit range (see F5).

- **Read in full**:
  - all source changes in `src/` (accounts page, actions, the three client forms, `ConnectLanding`, `ChooserForm`,
    `connect.ts`, `overview.ts`, `derive.ts`, Composer, `ScheduleDialogs`, both compose pages, `Checklist`,
    `SetupNotice`, the four gate pages, the overview page, `docs.ts`, `ProjectSwitcher`, `setup-form`);
  - the new pure modules and their tests;
  - every test diff and new test file;
  - `docs/getting-started.md`, and the diffs of `docs/accounts.md`, `docs/design-system.md`, `docs/decisions.md`,
    `docs/index.md` and `mkdocs.yml`.
- **Read for context, unchanged files**:
  - `Dialog.tsx`, `EmptyState.tsx`, `SegmentedControl.tsx`, `LiveRegion` usage;
  - the `services/accounts.ts` connect functions, the `dal/accounts.ts` `list()`, the `dal/posts.ts` `counts()`;
  - the calendar page and service, `roles.ts`, `access.ts`, `docs/limits.md` (media-required rows);
  - `src/providers/meta/candidates.ts`;
  - Next's `layout-router.js` scroll and focus handler (`node_modules/next/dist/client/components/layout-router.js:150-236`).
- **Not reviewed**: nothing in the diff was skipped. I did not re-run lint, typecheck, the full suite or the build: the
  constitution's review rule says to read implement's final pass, which reports them green after one fix
  (`.pipeline/implement.result.json`).
- **Probes run**: two targeted `node --experimental-strip-types` probes of `listedOrder`, both cited in F1.

## Verdict

The feature satisfies the spec, and the passes fit together. I found no blocking defect.

- **Card order** (US1) and **landing** (US2) share one structure: `ConnectLanding`'s selectors match the ids and the
  weekday radio the card renders.
- **New versus reconnected** uses one pure rule (`classifyConnect`) for all four actions.
- **One first-post rule.** The overview checklist and the Composer use the same `countsTowardFirstPost`, read from the
  same `scope.posts.counts()` (`overview.ts:26`, `:75`).
- **SetupNotice** reuses the exported `ChecklistRows`, so the gate rows can't drift from the overview's.

The defects I found are latent or cosmetic:

- `listedOrder` sorts the selection, not what the chooser showed, and drops grandchildren. No registered provider can
  trigger either (F1).
- Two claimed test cases are missing (F2).
- Some docs are inaccurate (F3).

I would ship it once the work is committed (F5), and once the human-owed checks below are done: the browser
walk-through (T047), the CI strict-docs build (T048) and the docket-ui skill edit.

## Findings

- [ ] MINOR F1 — The service's save order is not always "the order the chooser listed it", and `listedOrder` drops
      grandchildren.
      - **Where**: `src/server/services/connect.ts:238`, `src/lib/accounts/chooser-order.ts:6-11`,
        `src/app/p/[projectSlug]/accounts/connect/[attemptId]/ChooserForm.tsx:71`.
      - **Why**:
        - `ChooserForm` sorts the **full** candidate list, but `chooseConnectCandidates` filters to the selection
          **first** and then sorts. A selected child whose parent wasn't selected becomes a root in its payload
          position. Probe: payload `[P1, P2, C1(parent P1)]` with `C1` and `P2` selected. The screen shows `C1`
          first; the service saves `P2` first. The landing then goes to `P2`, against FR-011.
        - `listedOrder` only attaches direct children of roots. Probe: `[R, C(parent R), G(parent C)]` returns
          `[R, C]`. In the service, a selected grandchild would be silently not saved, while the action reports
          success. Before this entry every selected candidate was saved.
        - Neither can happen today. Only Meta emits `parent` (`src/providers/meta/candidates.ts:51`), each Instagram
          child directly follows its Page, and the tree is two levels deep. So this is latent, against the plan's own
          reason for adding the helper (research R4: "a future provider might not order them that way").
      - **Owed**:
        - in `chooseConnectCandidates`, run `listedOrder` over the full mapped payload, then filter by `wanted`;
        - make `listedOrder` keep every element: recurse, or append whatever is left in input order;
        - add a three-level case and a non-adjacent-payload case to `chooser-order.test.ts`.
      - **Traces**: FR-011, constitution V.

- [ ] MINOR F2 — Two obligations claimed by ticked tasks have no executed test, and one order assertion can't fail when
      its text is missing.
      - **Where**: `tests/integration/actions-authz.test.ts:489-504`,
        `src/app/p/[projectSlug]/compose/ScheduleDialogs.test.ts:20-31`, `src/server/services/overview.ts:24-28`,
        `tests/integration/accounts-ui.test.ts:272-273`.
      - **Why**:
        - **Credentials landing.** T019 and quickstart scenario 8 claim "credentials … return `landing`" for a new
          handle (slots) and with `accountId` (card). The test only calls `connectCredentialsAction` with empty fields
          and checks that the failure carries no landing (`:498`). The success expression
          (`accounts/actions.ts:56`) and the `priorIds` pre-read for this route never run in a test. I read the code
          and it is correct.
        - **First-post wiring.** `hasFirstPost`, the `firstPostDone` prop from both compose pages
          (`compose/page.tsx:34`, `compose/[postId]/page.tsx:35`) and the confirm-time capture
          (`ScheduleDialogs.tsx:73`, `:228`, `:309`) have no test. Only the leaf `CalendarLink` is rendered, with
          `show` passed in directly. T031's note admits the capture is held "by construction". If the prop wiring
          broke, the link would silently never appear.
        - **Vacuous assertion.** At `accounts-ui.test.ts:272-273`, `indexOf(...) < slots` also passes when
          "Needs reconnecting" or "Reconnect" is absent, because `indexOf` returns -1.
      - **Owed**:
        - an integration case for a successful credentials connect (new handle, and reconnect with `accountId`)
          using the existing fake PDS helper (`tests/helpers/fake-pds`), asserting `data.landing`;
        - a service test that `hasFirstPost` is false for an empty project and true after a scheduled post;
        - `toBeGreaterThan(-1)` guards on the two `indexOf` values.
      - **Traces**: FR-014, FR-030, FR-031, US1 scenario 4, constitution II.

- [ ] MINOR F3 — The docs drift from what was built.
      - **Where**: `docs/design-system.md:249`, `docs/accounts.md:66`, `docs/decisions.md:1361`.
      - **Why**:
        - **Design system.** The SetupNotice row says it is used on "(Generate, Jobs, Compose)". Compose doesn't use
          it: the only callers are Generate and the three job pages. It also says the panel shows "the unmet
          prerequisites", but it lists every prerequisite with its status (US3 scenario 1; Done rows render).
        - **Accounts.** contracts/ui.md §8 asks `docs/accounts.md` for "one sentence that connecting an account opens
          its posting slots". Only the posting-instructions sentence changed, so the new landing is undocumented for
          users.
        - **Decisions.** The 033 "Intl, not Temporal" entry gives the choice but not the reason. The constitution says
          "wall-time conversion only via Temporal", and research R10 says the reason (instant→date is unambiguous;
          Temporal is server-only today) is to be recorded.
      - **Owed**:
        - in the design-system row, replace "Compose" with "Batch jobs, New batch job, New batch job from CSV", and
          "the unmet prerequisites" with "every prerequisite with its status";
        - add the landing sentence to `docs/accounts.md`;
        - add R10's reason to the decisions entry.
      - **Traces**: FR-026, the constitution's Docs workflow, research R10.

- NOTE F4 — Two small departures from the plan's layout. Neither breaks a requirement.
  - **Dialog footer order.** In the three dialogs the calendar link comes **after** Close
    (`src/app/p/[projectSlug]/compose/ScheduleDialogs.tsx:121`, `:270`, `:346`). contracts/ui.md §4 says "the link
    first, then Close". FR-035 is still met (keyboard-reachable, `buttonStyles` primary), and the built order matches
    the existing footer convention (secondary first, primary last). Pick one and align the contract or the code.
  - **Status-block order.** The card shows "Last error" before "Connected …"
    (`src/app/p/[projectSlug]/accounts/page.tsx:184`, `:187`). Research R1 planned to swap them. FR-002 lists the
    section's contents, not their order.

- NOTE F5 — The whole implementation is uncommitted.
  - 38 modified and 15 untracked non-spec files are in the working tree, and `specs/033-accounts-first-post/tasks.md`
    is untracked too.
  - The constitution's workflow expects per-task Conventional Commits with explicit paths. Whoever commits (the runner,
    or a human) needs `feat` for the user-visible parts (card order, landing, SetupNotice, calendar link, guide link),
    `fix` for the two accessibility fixes, and `docs`/`test` as appropriate, and must stage explicit paths only.
  - The docket-ui skill edit is still owed to a human (`docs/decisions.md:1367`, FR-027's fallback route).

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Runtime check owed |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-063) | 52 | 52 | 0 | 0 | 0 | 4 (FR-010 focus, FR-013 announcement, FR-047 strict build, FR-063 390 px) |
| Success criteria | 9 | 9 | 0 | 0 | 0 | 3 (SC-002, SC-005, SC-006 strict build) |
| Acceptance scenarios (US1–US6) | 31 | 31 | 0 | 0 | 0 | 5 (US1.6, US2.1–2.4 focus) |
| Edge cases | 15 | 15 | 0 | 0 | 0 | 2 (sticky-header scroll, JS-off fragment jump) |
| Constitution principles I–VII | 7 | 7 | 0 | 0 | 0 | 0 |
| Constitution constraints and workflow (Temporal, accessibility, docs, commits) | 4 | 2 | 2 (docs: F3; commits: F5) | 0 | 0 | 1 (accessibility in a browser) |

**Notes on the counts**:

- FR-011 is counted as satisfied because it holds for every registered provider; the latent defect is F1.
- FR-026 is counted as satisfied: the row exists with props, when to use it and the EmptyState lineage. Its wrong
  page list is F3.
- FR-047: the published-docs test covers the app's links, but the mkdocs strict build itself is owed to CI.

**Sweep categories the constitution requires**:

- **Concurrency.** The new-versus-reconnected pre-read runs before the save, in the same `runAction`
  (`accounts/actions.ts:44`, `:133`). The only race is another owner connecting the same account in between. Its only
  effect is the message wording and the focus target, as research R3 accepts. Two members can both see the
  first-post link (an accepted edge case). No locks were added or reordered.
- **Idempotency.** There are no new writes. FR-017 is checked by comparing the activity row count between the action
  and the bare service (`actions-authz.test.ts:507-514`).
- **Authorization and scoping.**
  - The landing is honoured only for `account:manage` and an id in the page's own list (`accounts/page.tsx:101-110`);
    forged and editor cases are tested.
  - `hasFirstPost` goes through the scoped DAL and requires view; the Composer reads it only for `post:schedule`
    (editors hold it: `access.ts:56`).
  - The `listAccounts` pre-read needs only view, and the service still enforces manage as before.
- **Time zones and DST.** `zonedDate` converts instant→date with Intl, which can't be ambiguous, and is tested across
  the date line. The calendar accepts `view=month&date=YYYY-MM-DD` (`calendar/page.tsx:40-47`). All three outcome
  types carry `scheduledAt` as an ISO string (`queue/index.ts:12`).
- **Error paths.** Every failing action returns before `landingFor`. `ConnectLanding` tolerates missing elements and a
  bad selector. The calendar falls back to its default view on a bad date. `CalendarLink` renders nothing when every
  row failed.
- **Secrets.** The landing URL carries ids and counts only. The credentials values are cleared before `router.push`
  (`ConnectCredentialsForm.tsx:56-58`). The failure results' JSON is checked for no `landing`, and the existing
  no-echo test is kept.

## What I could not check

- **The browser walk-through (T047, blocked).** It needs a real browser at desktop width and 390 px:
  - that focus lands on the checked weekday radio, or on the card's `h3` for a reconnect;
  - that VoiceOver announces the LiveRegion once;
  - that the landed heading sits below the sticky header;
  - the editor view, and the keyboard order in the dialogs.

  From the installed source, Next's own hash handling focuses the hash element in the layout phase. That is a no-op
  here, because neither the `h4` nor the `section` is focusable. `ConnectLanding`'s passive effect runs afterwards, so
  its focus should win (`node_modules/next/dist/client/components/layout-router.js:236`). That is from reading, not
  from running it.
- **The hash after a server-action redirect.** I didn't confirm that `redirect()` from `chooseConnectCandidatesAction`
  keeps the `#account-…` fragment on the client. `ConnectLanding` scrolls by id rather than by the hash, so the
  landing shouldn't depend on it.
- **The mkdocs strict build (T048).** `mkdocs` isn't installed in the sandbox; it is owed to the PR's docs workflow.
- **The docket-ui skill edit.** It is outside this phase's write scope and owed to a human (`docs/decisions.md:1367`).
- **The full suite, lint, typecheck and build.** I didn't re-run them, per the constitution's review rule. I relied on
  implement's report: green, after one fix to `tests/integration/bluesky/no-secrets.test.ts`. CI on the PR will re-run
  them once the work is committed.
