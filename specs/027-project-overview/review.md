# Review: Project overview and getting started

**This is a re-review after remediation.** The first review (four MAJOR findings, F1–F4) added tasks T045–T048.
Implement has since ticked all four and committed the work. Under the constitution's rule for re-reviews
(`.specify/memory/constitution.md:125-128`), this pass checks two things:

- that each earlier finding is fixed;
- that the files changed by the remediation brought in no regression.

Anything new it noticed is recorded as MINOR or NOTE, never as blocking.

Reviewed 33 files changed across 6 commits, against `6dcdca7...HEAD` (`6dcdca7` is the merge-base with `origin/main`).
The working tree is clean. The whole feature is now committed in `ba0a60d`, `3cd51ad`, `4e71605` and `ebbbf28`, so
this review covers a committed diff, not the working tree the first review had to read.

**Read in full:**

- `src/lib/overview/derive.ts` and `src/lib/overview/derive.test.ts`
- `src/server/services/overview.ts`
- `src/app/p/[projectSlug]/(overview)/page.tsx` and `src/app/p/[projectSlug]/(overview)/loading.tsx`
- `src/components/ui/Checklist.tsx` and all six files in `src/components/overview/`
- `tests/integration/overview/{ui.test.tsx,service.test.ts,nav.test.tsx}`
- the diffs to `src/components/shell/LeftNav.tsx`, `src/app/p/[projectSlug]/accounts/page.tsx`, the deleted
  `src/app/p/[projectSlug]/page.tsx`, `scripts/generate-icons.mjs`, `src/components/ui/icons.generated.ts`,
  `docs/decisions.md` and `docs/design-system.md`
- spec, plan, research, data-model, the three contracts, tasks and the previous review.md

**Sampled**, to check producer and consumer shapes:

- `src/server/services/posts/list.ts` (`counts` covers every status whatever the filter, and `relevantAt`)
- `src/server/services/{accounts,media,voice,members,scheduler-health}.ts`
- `src/server/services/invitations/index.ts:197-208` (`shownStatus` folds expired invitations out of "pending")
- `src/server/services/activity/index.ts:181-183` (Activity needs `post: view`, so editors can open "See all activity")
- `src/server/auth/access.ts`
- `src/server/dal/accounts.ts` (removed accounts are excluded)
- `src/server/llm/index.ts:20-47` and `src/server/storage/index.ts:27` (the test seams)
- the UI primitives (`Button`, `Card`, `EmptyState`, `PageHeader`, `Skeleton`, `Icon`, `LocalTime`)
- the other route `loading.tsx` files
- `src/app/globals.css` (no outline override)
- `.claude/skills/docket-ui/SKILL.md:31-33, 82-95`

**Not reviewed:** `.pipeline/*`, and the spec-kit artifacts as code.

**Ran myself:**

- `pnpm vitest run src/lib/overview tests/integration/overview`: 4 files, 70/70 passed.
- `pnpm vitest run tests/integration/failures/nav.test.ts "src/app/p/[projectSlug]/review/review.test.tsx" tests/integration/docs/published-docs.test.ts "src/app/p/[projectSlug]/ui-conventions.test.ts"`:
  4 files, 53/53 passed. `git diff` confirms the two pinned nav tests are unchanged (SC-007).
- `pnpm typecheck` (clean) and `pnpm lint` (0 errors, 20 warnings, none in this feature's files). The constitution
  says review shouldn't re-run these (`constitution.md:111-114`), so this was a deviation on my part. It changed no
  file, and the tree is still clean.

I didn't run the full suite or the build.

## Verdict

**The feature satisfies the spec and hangs together. Nothing blocks the merge.** All four MAJOR findings from the
first review are fixed, and the fixes hold up:

- A brand-new owner's home now has exactly one primary button, and a test pins it.
- The collapsed "Setup complete" `<details>` is rendered and asserted in markup.
- The SC-004 and SC-005 gaps are filled at the unit and markup layers.
- The feature is committed, with no stray `tasks.md-E`.

The remediation changed only button variants in three cards, plus tests and docs. I found no regression in those
files, and their tests pass.

What remains is MINOR and safe to ship. Three findings carry over from the first review: the docket-ui skill bullet
that only a person can edit (F5), the doubled "Optional" (F6) and the hand-rolled skeleton (F7). Three are new and
small: duplicated test blocks from two remediation passes (F10), the server-setup row labelled "Optional" (F11), and
Coming up rows that don't link to their posts (F12). I'd merge once a person has made the F5 one-line edit and CI is
green, and leave the other MINORs for the hardening entry.

### Earlier findings, re-checked

| Earlier finding | Status | Evidence |
|---|---|---|
| F1: four primary-styled buttons on a new project's home | **Fixed** | `src/components/overview/ComingUpCard.tsx:17`, `AccountsCard.tsx:19`, `PostsByStatusCard.tsx:16` and `ContentToolsCard.tsx:11` use `variant: "secondary"`. `src/app/p/[projectSlug]/(overview)/page.tsx:81` is the only `primary`. `tests/integration/overview/ui.test.tsx:72-74` asserts exactly one `bg-primary text-primary-foreground` link, reading "Connect an account" |
| F2: no test rendered the collapsed checklist | **Fixed** | `tests/integration/overview/ui.test.tsx:343-354` and `:412-429` assert a `<details>` without `open`, a `<summary>` reading "Setup complete" with `focus-visible:ring-2`, and the unfinished optional step and server-setup item inside it. `:356-368` and `:431-442` assert no Getting started card once everything is done. Heartbeat, LLM and storage are pinned in each case |
| F3: SC-004 and SC-005 gaps | **Fixed** | `src/lib/overview/derive.test.ts:391-421` covers the voice step (todo → done), the media step (todo → done → todo), populated voice and empty media lines with their hrefs, and editor variants of Posts by status (both states), Coming up (populated) and Needs attention (null). `tests/integration/overview/ui.test.tsx:445-476` renders a populated project as an editor, with the SC-003 sweep |
| F4: feature uncommitted, stray `tasks.md-E` | **Fixed** | Commits `3cd51ad` (feat), `4e71605` (test) and `ebbbf28` (docs) are grouped as the finding asked, and each ends with a Co-Authored-By trailer. `git status` is clean, and `specs/027-project-overview/tasks.md-E` is gone |

## Findings

- [ ] MINOR F5 — FR-053 is still only partly done: the docket-ui skill's App shell bullet doesn't list Overview
      where:  .claude/skills/docket-ui/SKILL.md:31-33, docs/decisions.md:1292-1294
      why:    The bullet still starts the nav at "Publish". The pipeline sandbox refuses writes under `.claude/skills/`,
              so implement logged the edit as an open item, as T041 allowed. No pipeline phase can make this edit,
              so it isn't a remediation task.
      owed:   A person adds "Overview (the project home, ungrouped) first" before "Publish" in that bullet, then
              removes the open item from decisions.md.
      traces: FR-053, T041

- [ ] MINOR F6 — Optional checklist rows still say "Optional" twice
      where:  src/lib/overview/derive.ts:223, src/lib/overview/derive.ts:236, src/lib/overview/derive.ts:248,
              src/components/ui/Checklist.tsx:50
      why:    The voice, media and invite descriptions start with "Optional.", and `Checklist` also renders an
              "Optional" label for `optional: true`. Each optional row therefore reads "Optional · To do" and then
              "Optional. Teaches the generator…". This is unchanged since the first review.
      owed:   Drop the "Optional. " prefix from the three descriptions.
      traces: FR-013, FR-011

- [ ] MINOR F7 — The overview skeleton still re-implements the `Skeleton` and card primitives
      where:  src/components/overview/OverviewSkeleton.tsx:1-11, src/components/ui/Skeleton.tsx:3, src/components/ui/Card.tsx:4
      why:    The `block` constant is the same class string as `Skeleton`, and `CardPlaceholder` copies `cardStyles`
              minus `shadow-card`. contracts/ui.md:106-114 calls for `Skeleton` blocks and an `sr-only` "Loading
              overview" span. The code uses `aria-label` on `role="status"`, as the other routes' loading files do.
              What a user sees is fine: a label, `motion-safe` pulsing only, and no "Loading…" text.
      owed:   Build the skeleton from `<Skeleton className=…/>` and `cardStyles`.
      traces: FR-046, FR-047

- [ ] MINOR F10 — Two remediation passes each added the F2 and F3 tests, so ui.test.tsx now has them twice
      where:  tests/integration/overview/ui.test.tsx:219-245 and :445-476 (populated editor render),
              tests/integration/overview/ui.test.tsx:330-369 and :406-443 (collapsed checklist),
              tests/integration/overview/ui.test.tsx:336-341 and :398-404 (two `finishRequired` helpers)
      why:    These are near-identical cases under different describe names ("collapsed checklist (review F2)" and
              "collapsed checklist markup (F2)"), plus a second module-level helper that shadows the describe-local
              one. Both copies pass, so nothing is wrong today. But a later change to one copy will silently leave
              the other asserting the old behaviour, and each copy costs a seeded project per run. This is the
              cross-pass seam: neither pass knew the other had done T046 or T047.
      owed:   Keep one of each pair: the module-level `finishRequired`, one collapsed-checklist describe and one
              populated-editor test. Merge any assertion only one of them has. For example, :238-239 checks the
              seeded owner and admin emails, and :468-470 checks "Content tools" and "Server setup".
      traces: T046, T047

- [ ] MINOR F11 — The owner's "Server setup" row is labelled "Optional", even when it says the scheduler isn't running
      where:  src/app/p/[projectSlug]/(overview)/page.tsx:48, src/components/ui/Checklist.tsx:50
      why:    `serverSetupItem` sets `optional: true`, so the row reads "Server setup · Optional · To do" above "The
              scheduler isn't running". FR-028 says the row never blocks the collapse. It doesn't make the row
              optional, and FR-013 marks only steps 4–6 "Optional". A stopped scheduler means nothing publishes, so
              "Optional" understates it to the one person who can fix it.
      owed:   Set `optional: false` on the server-setup item. The collapse rule is already enforced in
              `deriveChecklist` (src/lib/overview/derive.ts:258-263), not by this flag.
      traces: FR-025, FR-028, FR-013

- [ ] MINOR F12 — Coming up rows don't link to their posts, though the data model says they do
      where:  src/components/overview/ComingUpCard.tsx:26-31, specs/027-project-overview/data-model.md:50,
              src/lib/overview/derive.ts:33
      why:    `UpcomingPost.id` is documented as "Links to `/p/{slug}/posts/{id}`". The card uses it only as a React
              key, so each row is plain text and the only way onward is "Open calendar". FR-036 doesn't require a
              per-post link, so this is drift from the plan, not a spec violation.
      owed:   Wrap each row's excerpt in a `Link` to `/p/{slug}/posts/{id}` with a visible focus ring. Otherwise, drop
              the sentence from data-model.md.
      traces: US3 ("Each item links to the page where it's handled"), data-model UpcomingPost

- NOTE F8 — The derive signatures still differ from `contracts/overview-service.md:32-34`. The contract has
  `deriveChecklist(facts, names)` and `needsAttention(facts, names)`. The code has `deriveChecklist(facts)`
  (src/lib/overview/derive.ts:172) and `deriveNeedsAttention(facts)` (derive.ts:273), which compute names through
  `names()` (derive.ts:143). Every consumer agrees with the code, so the contract is the stale side.

- NOTE F9 — Needs attention's "Failed" counts **posts** (`failed` + `partially_failed`, src/lib/overview/derive.ts:277,
  per D4). The Failures page header counts **targets** (src/app/p/[projectSlug]/failures/page.tsx:181). FR-033 only
  requires the review and decision counts to match the nav, and they do, because they come from the same functions.
  Entry 3 may want to align the wording.

- NOTE F13 — In a project with no accounts, the page offers "Write a post" while step 3 says "Needs an account
  first". It appears as the Posts by status empty action (src/lib/overview/derive.ts:397) and as an editor's header
  primary action (derive.ts:412-417). Step 3 is at derive.ts:212. Both follow the spec literally (FR-041, and FR-003's
  "otherwise"), so this isn't a defect. Entry 2 or 4 may want the empty Posts action to depend on an account too.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-061) | 46 | 44 | 2 (FR-046 via F7, FR-053 via F5) | 0 | 0 |
| Success criteria | 9 | 8 | 0 | 0 | 0 |
| Acceptance scenarios (US1–US6) | 30 | 30 | 0 | 0 | 0 |
| Edge cases | 12 | 11 | 0 | 0 | 0 |
| Plan/research decisions (R1–R7, D1–D12) | 19 | 19 | 0 | 0 | 0 |
| Constitution principles (I–VII, Engineering, Workflow) | 9 | 9 | 0 | 0 | 0 |
| Earlier blocking findings (F1–F4) | 4 | 4 fixed | 0 | 0 | 0 |

- **SC-009** (no sideways scroll at 390 px) and the "Narrow screens" edge case are in neither column, because they
  need a browser. The markup is `grid-cols-1` (`minmax(0,1fr)`) with `min-w-0` and `truncate` on the long text, and
  `ui.test.tsx:247-252` pins that there are no fixed widths. That's evidence, not proof.
- **SC-002** is now satisfied (F1). The only primary is the header's, and `ui.test.tsx:72-74` asserts it.
- **SC-003** is now satisfied. The editor sweep runs on an empty project (`ui.test.tsx:122-128`) and a populated one
  (`:238-244`, `:470-475`). The service output check is `service.test.ts:51-60`.
- **SC-004** is satisfied. Every one of the five sections plus the checklist is tested empty and populated, for an
  owner and an editor. Some of those cases are unit tests in `derive.test.ts`, some are markup tests in
  `ui.test.tsx`.
- **SC-005** is satisfied.
  - Steps 1–3: To do → Done → back (`derive.test.ts:67-81`), and the account removal end to end (`ui.test.tsx:93-97`,
    `service.test.ts:43-48`).
  - Voice and media: `derive.test.ts:395-405`.
  - Invite: `:376-381`.
- **SC-007**: both pinned nav tests ran, unedited, and passed.
- **Constitution Workflow** is now satisfied (F4 fixed). I didn't count the Co-Authored-By trailer naming Sonnet 5.5,
  the model that ran implement, against it. `constitution.md:92` names Opus 5.5 literally, but the trailer is there
  to attribute the real author.

Per the re-review rule, I didn't open new lines of inquiry into concurrency, idempotency, time zones or authorization.
The first review covered those, and the remediation changed none of the code involved: it changed button variants
and tests only. I did confirm one authorization detail in passing. "See all activity" is safe for editors, because
Activity requires `post: view` (src/server/services/activity/index.ts:181-183), which editors have
(src/server/auth/access.ts:56).

## What I could not check

- **Browser behaviour** (T044 is still unticked and marked blocked):
  - the 390 px layout with no horizontal scroll (SC-009);
  - visible focus on the plain text links (Needs attention items, "See all activity", the Accounts slots link, the
    Posts by status rows, the server-setup docs links). These carry no `focus-visible:ring-*`. They rely on the
    browser's default outline, which `globals.css` doesn't suppress. That matches existing links such as
    `src/components/activity/ActivityFilters.tsx:126`, but a person should confirm FR-045 by tabbing through the page;
  - `<details>` opening with Enter or Space with JavaScript off;
  - the overview skeleton on a throttled load, with Settings keeping the generic "Loading…" line;
  - SC-001's one-click landing on each step's target anchor.

  This headless phase has no browser. Project memory says these walk-throughs can be run through the chrome-devtools
  MCP with the local mock setup.
- **The full suite and the build** on this commit. I ran only the overview, pinned-nav, docs-link and UI-convention
  tests. CI must confirm the rest, including `tests/integration/scheduler/concurrency.test.ts`, which implement saw
  flake once.
- **A real AI provider or real storage.** These were exercised only through `setLlmForTests` and `setStorageForTests`.
- **The F5 SKILL.md edit**, which needs a person, because the pipeline can't write under `.claude/skills/`.
