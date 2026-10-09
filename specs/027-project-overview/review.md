# Review: Project overview and getting started

Reviewed 33 file(s) changed across 3 commit(s) plus the uncommitted working tree, against `6dcdca7` (merge-base with
`origin/main`). **Most of the implementation is not committed.** `6dcdca7...HEAD` holds only the spec, the plan, and
the types and icons (`ba0a60d`). The page, service, components, nav, tests and docs are working-tree changes (13 new
untracked files, 7 modified tracked files). So this review covers **base → working tree** (`git diff 6dcdca7` plus the
untracked files), not a committed diff. See F4.

Read in full: `src/lib/overview/derive.ts`, `src/lib/overview/derive.test.ts`, `src/server/services/overview.ts`,
`src/app/p/[projectSlug]/(overview)/page.tsx`, `src/app/p/[projectSlug]/(overview)/loading.tsx`,
`src/components/ui/Checklist.tsx`, all six files in `src/components/overview/`, `src/components/shell/LeftNav.tsx`,
`tests/integration/overview/{service.test.ts,ui.test.tsx,nav.test.tsx}`, the diffs to
`src/app/p/[projectSlug]/accounts/page.tsx`, `scripts/generate-icons.mjs`, `src/components/ui/icons.generated.ts`,
`docs/decisions.md` and `docs/design-system.md`, and every spec artifact (spec, plan, research, data-model, contracts,
quickstart, tasks).

Sampled, to check producer/consumer shapes: `src/server/services/posts/list.ts`, `src/server/dal/posts.ts` (list order,
`relevantAt`, `counts`), `src/server/services/{accounts,members,connect,media,voice,scheduler-health,review,failures}.ts`,
`src/server/services/invitations/index.ts`, `src/server/dal/members.ts`, `src/server/llm/index.ts`,
`src/server/auth/access.ts`, `src/app/p/[projectSlug]/layout.tsx`, the UI primitives (`Card`, `EmptyState`, `Badge`,
`PageHeader`, `Skeleton`, `Icon`, `LocalTime`, `Button`), `tests/setup/worker-db.ts`,
`tests/integration/docs/published-docs.test.ts`, and the last implement pass's log (`.pipeline/implement.result.json`).

Not reviewed: the spec-kit artifacts as code, and `.pipeline/*` beyond the implement log. I didn't re-run lint,
typecheck, the suite or the build (Constitution, Development Workflow: review reads implement's results). Implement's
last pass reports lint and typecheck clean, the build passing, and 29/29 overview + scheduler-health tests passing
after a fix (see "What I could not check").

## Verdict

**The feature mostly meets the spec, and the pieces fit together. It shouldn't merge yet.** The design held up across
the nine implement passes:

- One service collects plain facts through existing scoped services.
- One pure module holds every rule, with a single `names()` helper used by every section.
- The page and cards consume that module's types unchanged.
- The nav change sits outside `NAV_SECTIONS`, as planned.

I found no duplicated logic, interface drift or dead code between passes. Role checks are server-side, and emails are
dropped inside the service.

Four MAJOR problems block the merge:

1. A brand-new project shows **four primary-styled buttons**, where SC-002 and quickstart scenario 1 require one.
2. The P1 "Setup complete" collapse is **never rendered in any test**, although T014 is ticked as covering it.
3. SC-004 and SC-005 coverage is **partial**: some section, state and role paths have no test anywhere.
4. Almost the whole feature is **uncommitted**.

All four are small, mechanical fixes. I've added them as T045–T048.

## Findings

- [ ] MAJOR F1 — A brand-new project's home renders four primary-styled buttons, not one
      where:  src/components/overview/ComingUpCard.tsx:17, src/components/overview/AccountsCard.tsx:19,
              src/components/overview/PostsByStatusCard.tsx:16, src/app/p/[projectSlug]/(overview)/page.tsx:81,
              tests/integration/overview/ui.test.tsx:52-70
      why:    Take an owner with no accounts and no posts. They get the header's "Connect an account", plus three empty-state
              actions: Coming up "Connect an account", Accounts "Add an account" and Posts by status "Write a post".
              All four use `buttonStyles({ variant: "primary" })`. Three of them, plus checklist step 1, link to the
              same `/accounts#add-account`. SC-002 (spec.md:451) and quickstart scenario 1 (quickstart.md:42) say
              "exactly one primary action". `Button.tsx:4` defines `primary` as "the one main action of a form or
              page". At `lg`, the Coming up and Accounts cards put two filled buttons side by side, which
              design-system.md §10 forbids. That brings back the "option overload" this entry exists to fix. The
              scenario 1 test never counts primary buttons, so it passes anyway.
      owed:   Style the overview's empty-state actions as `secondary`. Keep the copy and destinations that FR-037,
              FR-039 and FR-041 require. Add a markup assertion that a brand-new owner home contains exactly one
              `bg-primary text-primary-foreground` link, and that it's the header's "Connect an account".
      traces: SC-002, FR-003, US1-1, quickstart scenario 1

- [ ] MAJOR F2 — No test renders the collapsed checklist ("Setup complete" in a native `<details>`), but T014 is ticked
      as covering it
      where:  src/components/ui/Checklist.tsx:70-76, src/app/p/[projectSlug]/(overview)/page.tsx:91,
              tests/integration/overview/ui.test.tsx:80-87
      why:    Scenario 3 of the US1 markup test only checks that the required-step titles disappear. It would still pass
              if `collapsedSummary` were ignored, if the `<details>` rendered `open`, or if the checklist were dropped
              even though a server-setup row or an unfinished optional step remains. The only mention of "Setup
              complete" in any test is a `not.toContain` (ui.test.tsx:70). The `<details>`/`<summary>` branch of
              `Checklist`, the FR-016 "expands without JavaScript" behaviour and its focus ring (contracts/
              checklist-component.md) have no coverage. So US1 acceptance 4, a P1 scenario, is untested at the
              level a user sees, and `tasks.md` T014 overstates what was verified.
      owed:   Add deterministic markup cases. (a) Required steps done, plus an unfinished optional step or a
              server-setup item: assert `<details>` without `open`, a `<summary>` reading "Setup complete" with
              `focus-visible:ring-2`, and the unfinished item inside. (b) Every shown step done, no server-setup
              row: no "Getting started" card at all. Pin the heartbeat, LLM and storage seams so the outcome doesn't
              depend on the environment.
      traces: US1-4, FR-016, FR-028, quickstart scenario 3, T014

- [ ] MAJOR F3 — SC-004 and SC-005 are partially met: several section, state and role paths, and two checklist steps'
      transitions, have no test at any layer
      where:  src/lib/overview/derive.ts:378, src/lib/overview/derive.ts:387, src/lib/overview/derive.ts:231-241,
              src/lib/overview/derive.test.ts:281-298, src/lib/overview/derive.test.ts:353-389,
              tests/integration/overview/ui.test.tsx:198-213
      why:    SC-004 asks for empty and populated states for both owner and editor in every section (≥ 20 cases).
              SC-005 asks that each step's status move To do → Done → back. Untested anywhere:
              - Content tools, voice populated: "{n} voice profiles" and the "Open voice profiles" link to Voice
                (derive.ts:378).
              - Content tools, media empty: "No images or videos yet." and "Upload images or videos" (derive.ts:387).
              - The media checklist step (derive.ts:231-241), in any state. The derive fixture's `libraryItems: null`
                hides it.
              - The voice step reaching Done with ≥ 1 profile.
              - Posts by status for an editor, in either state.
              - Coming up populated for an editor.
              - Needs attention empty for an editor.
              SC-003's sweep (no emails, env var names or commands) runs on the empty editor page only, not on "a
              fully populated one". T025 and T033 are ticked as covering SC-004.
      owed:   Add these as unit cases in derive.test.ts:
              - voice step todo ↔ done;
              - media step todo → done → todo;
              - voice-populated and media-empty Content tools lines, with their hrefs;
              - editor variants of Posts by status, Coming up and Needs attention.
              Add one ui.test.tsx editor render of a populated project (account with a slot, scheduled posts, a
              post in review, a failed post). It should check the section contents and repeat the SC-003 sweep:
              seeded emails, `LLM_|S3_|_CLIENT_ID|pnpm|docker`, `#add-account`, `/voice/new`, invite.
      traces: SC-003, SC-004, SC-005, FR-042, FR-043, FR-013, T025, T033

- [ ] MAJOR F4 — The feature isn't committed, and a stray stale copy of tasks.md sits beside it
      where:  .specify/memory/constitution.md:85-88, specs/027-project-overview/tasks.md-E:134-148
      why:    The constitution says "Commit after each completed task … Stage explicit paths only". Since the
              types and icons commit (`ba0a60d`), no implement pass has committed anything. The overview page and
              loading files, the service, `Checklist`, the six overview components, the `LeftNav` change, the
              Accounts anchor, all three test files and both docs edits exist only in the working tree. A PR from
              this branch today would contain the types and icons and nothing else. `tasks.md-E` is a BSD `sed -i -E`
              backup in which T034–T043 are still unticked. A directory-level add of `specs/027-project-overview/`
              would commit a second, contradictory task list.
      owed:   Delete `specs/027-project-overview/tasks.md-E`. Then commit the landed work in small Conventional
              Commits with explicit paths, for example `feat(overview): …` (service, derive, page, loading, components,
              Checklist, nav, Accounts anchor), `test(overview): …` (the three test files and derive.test.ts) and
              `docs(overview): …` (design-system, decisions, tasks.md and review.md). Each message ends with the
              Co-Authored-By trailer. Never use `git add -A` or `git add .`.
      traces: Constitution Development Workflow (Commits)

- [ ] MINOR F5 — FR-053 is only partly done: the docket-ui skill's App shell bullet doesn't list Overview
      where:  .claude/skills/docket-ui/SKILL.md:31-33, docs/decisions.md:1292-1294
      why:    The sandbox refuses pipeline writes under `.claude/skills/`. Implement followed T041's fallback and
              logged the edit as an open item, but the skill still says the nav starts with Publish. No pipeline
              phase can fix this, so it doesn't block the merge and isn't a remediation task.
      owed:   A person adds "Overview (the project home, ungrouped) first" before "Publish" in that bullet.
      traces: FR-053, T041

- [ ] MINOR F6 — Optional checklist rows say "Optional" twice
      where:  src/lib/overview/derive.ts:223, src/lib/overview/derive.ts:236, src/lib/overview/derive.ts:248,
              src/components/ui/Checklist.tsx:50
      why:    The descriptions for voice, media and invite start with "Optional.", and `Checklist` also renders an
              "Optional" label whenever `optional: true`. The pass that wrote the steps (T030) and the pass that wrote
              the component (T005) each added it, so every optional row reads "Optional · To do" and then
              "Optional. Teaches the generator…".
      owed:   Drop the "Optional. " prefix from the three descriptions.
      traces: FR-013, FR-011

- [ ] MINOR F7 — The overview skeleton re-implements the `Skeleton` and card primitives
      where:  src/components/overview/OverviewSkeleton.tsx:1-11, src/components/ui/Skeleton.tsx:3, src/components/ui/Card.tsx:4
      why:    The `block` constant is the same class string as `Skeleton`, and `CardPlaceholder` copies `cardStyles`
              without `shadow-card`. FR-046 and contracts/ui.md ("Loading") call for `Skeleton` blocks. Behaviour is
              fine (`role="status"`, a label, `motion-safe` only), so this is drift, not a defect a user would see.
      owed:   Build the skeleton from `<Skeleton className=…/>` and `cardStyles`.
      traces: FR-046, FR-047

- NOTE F8 — The derive signatures differ from `contracts/overview-service.md`, but every consumer agrees with the code.
  The contract lists `deriveChecklist(facts, names)` and `needsAttention(facts, names)`. The code has
  `deriveChecklist(facts)` (src/lib/overview/derive.ts:172) and `deriveNeedsAttention(facts)` (derive.ts:273), which
  compute names internally through `names()` (derive.ts:143). It also exports per-section derivers. The contract is
  the stale side.

- NOTE F9 — Needs attention's "Failed" counts **posts** (`failed` + `partially_failed`, src/lib/overview/derive.ts:277,
  as D4 decided). The Failures page header counts failed **targets** (src/app/p/[projectSlug]/failures/page.tsx:181).
  For a post with several failed targets, the two numbers differ. FR-033 only requires the review and decision counts
  to match the nav, and those come from the same functions, so this isn't a defect. Entry 2 or 3 may want to align
  the wording.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-061) | 46 | 44 | 2 (FR-046, FR-053) | 0 | 0 |
| Success criteria | 9 | 4 (SC-001, 006, 007, 008) | 4 (SC-002, 003, 004, 005) | 0 | 0 |
| Acceptance scenarios (US1–US6) | 30 | 29 | 1 (US1-1, via F1) | 0 | 0 |
| Edge cases | 12 | 11 | 0 | 0 | 0 |
| Plan/research decisions (R1–R7, D1–D12) | 19 | 19 | 0 | 0 | 0 |
| Constitution principles (I–VII, Engineering, Workflow) | 9 | 8 | 1 (Workflow commits, F4) | 0 | 0 |

- SC-009 (no sideways scroll at 390 px) isn't counted in either column. It needs a browser. The markup uses
  `grid-cols-1`, which is `minmax(0,1fr)`, so the `truncate` children can't widen the track. That's evidence, not
  proof.
- The edge case "Narrow screens" is unverified for the same reason.
- SC-003's code holds: the service drops `email`, `redirectUri`, `paste` and `lastError`
  (src/server/services/overview.ts:49-84). It's marked partial because the populated-editor sweep is untested (F3).

The categories the constitution requires on a first review:

- **Concurrency and locking; idempotency and retries.** Not applicable. The feature is read-only and starts no
  transactions. Parallel reads under READ COMMITTED can be a moment apart, which only affects display.
- **Authorization and project scoping.** Checked.
  - Every read goes through scoped services, and nothing imports `@/server/db`.
  - Conditional reads match the permissions: invitations only with `invitation:create`, connect groups only for
    owners with no accounts, voice and media only when configured.
  - The server-setup row checks `scope.membership.role` on the server.
  - Editors never receive manage actions (derive.ts:190, 200, 226).
- **Time zones and DST.** Checked. The expiry window is absolute milliseconds from the DB clock. All times render
  through `LocalTime` with the project's zone.
- **Error, timeout and ambiguous paths.** Checked. Service errors propagate to `error.tsx`. `generateMetadata`
  swallows only `NotFoundError` (page.tsx:27-30).
- **Secrets in logs and responses.** Checked, as for SC-003 above.

## What I could not check

- **Browser behaviour (T044, still blocked):**
  - 390 px layout and horizontal scroll (SC-009);
  - keyboard focus rings on plain text links (the Needs attention, slot and server-setup links rely on the browser's
    default focus outline);
  - `<details>` opening with Enter or Space with JavaScript off;
  - the overview skeleton on a throttled load, and the generic state on Settings;
  - SC-001's one-click landing on each step's target.
  Memory says these walk-throughs can be run through the chrome-devtools MCP with the local mock setup.
- **A full green suite on the final code.** Implement's last pass saw two full-suite failures:
  - `ui.test.tsx` was order-dependent, then fixed by clearing heartbeats at ui.test.tsx:230. That's safe, because
    each worker has its own DB clone (tests/setup/worker-db.ts:1-3).
  - `tests/integration/scheduler/concurrency.test.ts` failed once, passed when run alone, and was called a flake.
  The suite wasn't re-run after the fix. This feature doesn't touch scheduler code, but CI has to confirm.
- **The pinned nav tests (SC-007).** I didn't re-run them myself. Implement's full run named only the two failures
  above.
- **Real AI and storage configuration.** These were only exercised through `setLlmForTests` and
  `setStorageForTests`. The AI "isn't set up" item is asserted in unit tests only, because the markup test can't
  rule out an LLM configured by the environment.
- **The SKILL.md edit (F5)** needs a person.
