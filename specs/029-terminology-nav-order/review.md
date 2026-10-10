# Review: Terminology, page descriptions and nav order

**This is the re-review after remediation (Phase 9, T052–T054).**

Reviewed 58 changed source, test and doc files against `268f44e` (merge-base with `origin/main`). There are 50
modified tracked files and 8 new ones: `src/lib/roles/roles.ts`, `roles.test.ts`, `tests/helpers/page-header.ts`
and five files under `tests/integration/terminology/`. The branch has 2 commits, `d6342e6` (spec) and `31b835d`
(plan). **All implementation and remediation work is still uncommitted**, and so is `tasks.md`. So this reviews
`268f44e` **plus the working tree** (`git diff HEAD` and the untracked files), not a commit range.

The constitution scopes a re-review: check that each earlier finding is fixed, and that the remediation brought no
regression. I did that, and I also re-read the whole feature diff as a whole.

Read in full:

- every `src/` diff (all 28 project route pages, `Composer.tsx`, `VoiceEditor.tsx`, both panels in
  `settings/members/`, `signup/page.tsx`, `invitations/page.tsx`, `p/new/*`, `LeftNav.tsx`, `PageHeader.tsx`,
  `StatusBadge.tsx`, `overview/derive.ts`, `roles.ts`);
- every changed or new test file, and `tests/helpers/page-header.ts`;
- the three doc diffs;
- spec.md §Edge Cases through §Success Criteria, tasks.md, and the constitution's Development Workflow.

For cross-checks I also read `src/server/auth/access.ts:20-59` (role wording), `tests/helpers/webhooks.ts:33-50`,
`tests/helpers/factories.ts:176-201` and `src/server/db/schema/jobs.ts:63,106` (job `sourceSummary` is NOT NULL,
1–200 characters). I sampled `implement.result.json` (the remediation pass's final message only).

Not re-read: research.md, contracts/, data-model.md and quickstart.md. The first review read them, and the
remediation did not touch anything they govern.

Commands run:

- `pnpm vitest run` on the 19 feature test files: **181/181 passed**.
- `pnpm typecheck`: passed.
- `pnpm lint`: 0 errors. There are 20 warnings, all already in 18 files outside this feature.
- The full `pnpm test`: **528 files passed, 2 skipped; 4974 tests passed, 2 skipped, 0 failed**.

The constitution says review should not re-run the full suite. I ran it anyway, because F1 was "the full suite is
red" and nothing else settles it. The remediation pass reported 2 failures (`retry-all-cap`,
`scheduler/concurrency`). It put them down to another test run sharing the database, and only re-ran those files.
Nothing is committed and there is no CI run. `pnpm build` was not run.

## Verdict

The feature now meets its spec, and the pieces fit together. All three blocking findings from the first review are
fixed and tested:

- F1: the full suite is green.
- F2: `/p/new` shows only the FR-070 sentence, pinned exactly.
- F3: the Webhook detail header and the three batch-job tab titles now have tests.

The remediation brought no regression. The design still hangs together across the passes:

- one role source (`src/lib/roles/roles.ts`), read by the invite form, members panel, signup, Invitations and Overview;
- one status vocabulary (`statusLabel`/`statusTone`);
- one `PageHeader`, with a single additive `aside` prop;
- no duplicated helper, interface drift or dead code.

Every project route renders a `PageHeader`; the two Compose routes get theirs through `Composer.tsx:248,333`.

What remains is not blocking:

- three MINOR items carried from the first review (narrow test assertions, the invite-form layout from plan R10,
  and some inaccurate lines in `docs/decisions.md`);
- FR-081, the docket-ui skill edit. It is the one unmet requirement, and no pipeline phase can write that file.
  A human must apply the three edits recorded at `docs/decisions.md:1352-1355`.

Before a PR can exist, someone must commit the work with explicit paths. After that it is ready for a human to merge.

## Status of the first review's findings

| Earlier finding | Status | Evidence |
|---|---|---|
| F1 MAJOR: full suite red on the Accounts ordering assertion | **Fixed** | `tests/integration/accounts-ui.test.ts:240` now matches `"Posting slots ("`. That string occurs only in the card heading (`accounts/page.tsx:224`), not in the definition (`:125`) or the table caption (`:228`). The full suite: 4974 passed, 0 failed. Recorded at `docs/decisions.md:1356`. |
| F2 MAJOR: `/p/new` appended the new sentence instead of replacing the old one | **Fixed** | `src/app/p/new/page.tsx:19` holds only the FR-070 sentence. `tests/integration/terminology/p-new.test.tsx:22-23` checks that the `<p>` straight after the `<h1>` equals the sentence exactly, so the old wording would now fail. |
| F3 MAJOR: no tests for the Webhook detail header or three tab titles | **Fixed** | `tests/integration/terminology/page-headers.test.tsx:193-205` renders `EndpointPage`. It checks "Webhook: {host}", the FR-012 description and `generateMetadata`, and closes its receiver in `finally`. `:207-215` checks "New batch job", "New batch job from CSV" and "Batch job: {sourceSummary}". |
| F4 MINOR: vacuous or narrow assertions | Open, carried as F4 below | — |
| F5 MINOR: invite form layout differs from R10 | Open, carried as F5 below | — |
| F6 MINOR: inaccurate lines in decisions.md | Open, carried and extended as F6 below | — |
| F7 MINOR: stray `tasks.md-E` backup | **Fixed** | The file is gone (`ls specs/029-terminology-nav-order/`). |
| F8 NOTE: FR-081 skill edit blocked by the sandbox | Still open, NOTE F8 below | — |
| F9 NOTE: nothing committed | Still true, NOTE F9 below | — |

## Findings

- [ ] MINOR F4 — Three test assertions are weaker than their tasks claim
      where:  tests/integration/jobs/ui.test.tsx:245, tests/integration/terminology/page-headers.test.tsx:224-231, tests/integration/connect/chooser-ui.test.ts:83
      why:    `expectPageHeader(html, { title: "", … })` asserts that the `<h1>` contains the empty string, which is
              always true. `page-headers.test.tsx:179` does check the real title. The SC-007 guard loops over 9 page
              descriptions only. T032 said it would also cover role descriptions and the FR-060 hints, and those
              are static strings I checked by eye: no env-var names, commands or `@`. The Connect test matches only
              the prefix "Connect". The expired-attempt branch (`connect/[attemptId]/page.tsx:35-36`) has no test.
              None of this hides a defect today. It means a regression in those spots would pass CI.
      owed:   - `jobs/ui.test.tsx:245`: pass the job's `sourceSummary` as the title.
              - SC-007 guard: extend the loop to the `ROLE_OPTIONS` descriptions and the four FR-060 hints.
              - Connect: add an expired-attempt case.
      traces: FR-090, SC-007

- [ ] MINOR F5 — The invite form keeps its old inline row, which plan R10 replaces for the stacked role cards
      where:  src/app/p/[projectSlug]/settings/members/invitations-panel.tsx:98, src/app/p/[projectSlug]/settings/members/invitations-panel.tsx:110
      why:    R10 lays out the form for cards in this order: email at full width, then the cards, then the Invite
              button `self-start`. It also removes the `mb-5` alignment hack. The code keeps the
              `flex flex-wrap items-end` row and the button's `mb-5`. FR-050's behaviour holds and is tested
              (`roles.test.tsx:57-71`): cards, descriptions, the owner filter and the Editor default. Nobody has
              checked in a browser how the card group wraps in that row, or where the button lands.
      owed:   Apply R10's layout. Or check it at desktop width and 390 px in the T051 walk-through and record the
              result.
      traces: plan R10, FR-050

- [ ] MINOR F6 — The 029 section of decisions.md misstates the calendar change and the role-source callers, and files the F1 note under the Open item
      where:  docs/decisions.md:1349, docs/decisions.md:1346, docs/decisions.md:1356
      why:    - `:1349` says the "calendar title shows the project time zone". The opposite landed: the zone moved
                out of the title into the description (FR-016, `calendar/page.tsx:84`, tested at
                `page-headers.test.tsx:134-144`).
              - `:1346` lists the role source's callers as the members panel, invite form and invitations page.
                It leaves out signup (`signup/page.tsx:44-46`) and Overview (`overview/derive.ts:144-148`).
              - The remediation added the "Pinned assertion changed (review F1)" bullet at `:1356`, directly under
                the numbered "Open item (needs a human)" list, so it reads as part of the human's to-do list.
      owed:   - Correct `:1349` and `:1346`.
              - Move the `:1356` bullet above the Open item paragraph.
      traces: FR-016, plan "Workflow: docs"

- NOTE F8 — FR-081 (the docket-ui skill) is still not done in the repo. The sandbox refuses writes to
  `.claude/skills/`, so T048 is marked blocked.
  - **What's recorded.** The three edits are at `docs/decisions.md:1352-1355`. They cover FR-081's three asks plus
    the "States" line still owed from 028. Their anchor ("**populated**.") exists at
    `.claude/skills/docket-ui/SKILL.md:90`.
  - **What's stale.** The app-shell bullet at `SKILL.md:32-33` still lists the old nav: "(Calendar, Posts, Compose,
    Review, Failures, Activity), Create (Generate, Jobs, Media, Voice)".
  - **Why it isn't a remediation task.** This is an unmet MUST. It isn't raised as blocking because no pipeline
    phase can write the file. A human must apply the edits, as in 027 and 028.

- NOTE F9 — None of the implement or remediation work is committed. Neither is `specs/029-terminology-nav-order/tasks.md`,
  which is untracked. The constitution's workflow wants a commit after each task, with explicit paths. Whoever
  commits next should split the work into the commits tasks.md's strategy names: `feat(nav)`, `feat(ui)`,
  `refactor(roles)`, `test(…)` and `docs(…)`. Commit `tasks.md` and this review with them. Run commitlint before
  opening the PR.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–008, 010–016, 020–021, 030–031, 040, 050–053, 060, 070–071, 080–081, 090) | 30 | 29 | 0 | 1 (FR-081, blocked by the sandbox, NOTE F8) | 0 |
| Success criteria (SC-001–007) | 7 | 7 (SC-002's phone width holds by construction; not seen in a browser) | 0 | 0 | 0 |
| User-story acceptance scenarios (US1 5, US2 4, US3 4, US4 4, US5 2) | 19 | 18 | 0 | 0 | 0 (US1-5 phone width: not checkable here) |
| Edge cases | 11 | 11 | 0 | 0 | 0 |
| First-review findings re-checked | 9 | 4 fixed (F1, F2, F3, F7) | — | — | 3 MINOR and 2 NOTE still open, none blocking |
| Constitution principles (I–VII, Engineering, Workflow) | 9 | 8 | 1 (Workflow: nothing committed; skill doc open) | 0 | 0 |

Where the requirements I spot-checked again live:

- **FR-001/002/005 (nav).** `LeftNav.tsx:10-23` has 13 items in FR-001 order, with Activity last in Project.
  `nav.test.tsx:25-63` checks them, and `failures/nav.test.ts:26-27` keeps Review above Failures.
- **FR-012/SC-001 (page headers).** Every FR-012 page except Overview, Accounts and Activity, whose headers this
  entry leaves unchanged, is covered by `expectPageHeader` in:
  - `page-headers.test.tsx`;
  - `chooser-ui.test.ts`, `api-keys/ui.test.tsx`, `notifications/ui.test.tsx` and `accounts-ui.test.ts`.
- **FR-051 (role wording).** It matches `access.ts:20-59`:
  - editors get `account`/`slot`/`voice` view-only and no `project:update`;
  - admins lack `create_owner` and `update_role`.
- **SC-003 (statuses).** All 7 target statuses render as "{account}: {Label}" (`accounts-statuses.test.tsx:55-85`).
- **SC-006 (assertion changes).** The only changed existing assertions are:
  - `failures/nav.test.ts:27` (FR-005);
  - `jobs/ui.test.tsx:67,77,108` and `roles/routes.test.tsx:176,187` (FR-007);
  - `accounts-ui.test.ts:240` (forced by the FR-020 definition, recorded at `decisions.md:1356`).
- **Scope guard (R20).** `git diff HEAD --stat -- src/server drizzle docker-compose.yml .env.example` is empty.

## What I could not check

- **The browser walk-through (T051, quickstart §4).** This phase has no running app or browser, so none of these
  were seen:
  - the nav order on the phone strip at 390 px;
  - how the invite form's card group wraps beside the email field and button (F5);
  - spacing from `PageHeader`'s `mb-6` inside `gap-*` wrappers (accepted in R6);
  - focus returning to the Failures heading after an action;
  - the absence of sideways scrolling.
- **`pnpm build`.** I didn't run it. Typecheck passes. The only change across the client boundary is a type-only
  import of `Role` into the client `invitations-panel.tsx`, and builds erase type-only imports. CI's build job is
  the check.
- **The docket-ui skill edit (F8).** It can only be checked after a human applies it.
- **CI and commitlint on a PR.** There is no PR yet, because nothing is committed (F9).
