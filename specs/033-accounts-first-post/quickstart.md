# Quickstart: validating the accounts restructure and first-post flow

How to prove this entry works. Exact copy and layout are in [contracts/ui.md](./contracts/ui.md), module shapes in
[contracts/modules.md](./contracts/modules.md) and value shapes in [data-model.md](./data-model.md). This guide
doesn't repeat them.

## Prerequisites

- The worktree is on branch `033-accounts-first-post`. Dependencies are pre-installed, and no new package is needed.
- A Postgres for tests, with `DATABASE_URL` pointing at it, as for every integration test. Test DBs are run-scoped.
- For the browser pass: the local mock setup (mock provider and mock LLM, `MOCK_PROVIDER_ENABLED=true`) used in the
  027–029 walk-throughs.

## 1. Targeted tests (per task)

Run only what a task touches, with stdin closed:

```bash
pnpm vitest run src/lib/accounts/connect-landing.test.ts src/lib/accounts/chooser-order.test.ts < /dev/null
pnpm vitest run src/lib/compose/first-post.test.ts src/lib/overview < /dev/null
pnpm vitest run src/components/ui/ui-atoms.test.ts src/components/ui/SetupNotice.test.tsx < /dev/null
pnpm vitest run tests/integration/accounts-ui.test.ts tests/integration/accounts-landing.test.ts < /dev/null
pnpm vitest run tests/integration/actions-authz.test.ts tests/integration/connect < /dev/null
pnpm vitest run tests/integration/roles/routes.test.tsx tests/integration/jobs/ui.test.tsx "src/app/p/[projectSlug]/generate/generate.test.tsx" src/lib/roles/prerequisites.test.ts < /dev/null
pnpm vitest run tests/integration/compose "src/app/p/[projectSlug]/compose/Composer.test.ts" < /dev/null
pnpm vitest run tests/integration/overview tests/integration/docs/published-docs.test.ts < /dev/null
pnpm vitest run tests/integration/failures/nav.test.ts < /dev/null
```

The new test file names are suggestions; tasks.md fixes them. Expected: all green.

## 2. Scenarios and what proves them

| # | Scenario (spec) | Proof |
|---|---|---|
| 1 | Card order is status → slots → instructions (closed) → Remove, for owners (US1.1-2, FR-001, SC-001) | `accounts-ui.test.ts`: index order of `account-{id}-name`, `account-{id}-slots`, `Posting instructions ·`, then the Remove text. This replaces the old `:240` assertion |
| 2 | Summary says `· Set` / `· None` without opening (US1.3, FR-004) | same file, two accounts, one with instructions |
| 3 | A needs-reconnect card shows the badge and reconnect control before Posting slots (US1.4) | same file: flag `needs_reauth` on a mock account; `Needs reconnecting` and `Reconnect` come before `account-{id}-slots` |
| 4 | Editors: no form, Remove, Actions column, mock or reconnect controls; instructions read-only inside a closed `<details>` (US1.5, FR-009) | same file, as the editor |
| 5 | The definition appears once; anchors `account-{id}`, `account-{id}-slots` and `add-account` still exist (FR-007, FR-008) | same file; the existing links in `derive.ts`, `ReauthBanner.tsx`, `lib/roles/calendar.ts` and `composer-logic.ts` are unchanged (grep in review) |
| 6 | `classifyConnect`, `landingHref`, `parseLanding` and `landingMessage` cover every row of research R6 and reject bad input (FR-010–FR-013, FR-018) | `connect-landing.test.ts` (pure) |
| 7 | Chooser save with 2 new → redirect to `?landed={first listed}&connected=2&reconnected=0#account-{id}-slots`; 1 new + 1 reconnected → `connected=1&reconnected=1`; refresh-only → `#account-{id}` (US2.1-2, US2.5) | integration: `chooseConnectCandidatesAction` with a sealed attempt (helpers in `tests/helpers/connect-group.ts`), catching `RedirectSignal` |
| 8 | Credentials connect returns `landing` to slots for a new handle and to the card with `accountId`; mock connect and reconnect likewise; results never echo field values (US2.3-4, FR-014) | `actions-authz.test.ts` (existing assertions still pass) plus new cases |
| 9 | Failures, cancels and callback redirects unchanged (US2.6, FR-015, FR-016) | `tests/integration/connect/callback-hint.test.ts` unchanged and green; a failing credentials connect returns no `landing` |
| 10 | Page with a valid landing: message under the slots heading (new) or in the status block (reconnect); `h3` gets `tabindex="-1"` only for a reconnect landing; `ConnectLanding` rendered once | `accounts-landing.test.ts` (page markup) |
| 11 | Page with a forged or stale landing (unknown id, editor viewer, counts 0/0, 501, repeated key): renders exactly as without it (FR-018, edge "no longer exists") | same file, comparing to a render with no query |
| 12 | No activity entry or notification is added by a connect beyond today's (FR-017) | count `activity` rows before and after a mock connect, compared with `main`'s behaviour (the same count the existing activity tests expect) |
| 13 | SetupNotice on all four gates, owner and editor; none when ready; the overview still uses Checklist (US3, SC-003) | the existing `roles/routes.test.tsx`, `jobs/ui.test.tsx` and `generate.test.tsx` "Before you can generate" assertions, plus a new marker check (`border-dashed` and `aria-labelledby="setup-notice-title"`); `overview/ui.test.tsx` unchanged |
| 14 | SetupNotice rows render status in words, ≤ 1 action, decorative icon (FR-021) | `SetupNotice.test.tsx` (static markup) |
| 15 | `countsTowardFirstPost` matches the overview step for every status mix (FR-031) | `src/lib/overview/*.test.ts`; existing overview tests unchanged |
| 16 | Calendar href: earliest `ok` time, project-zone date across a date line (e.g. 23:30 UTC in Pacific/Auckland → next day), `now` → bare calendar, all-failed → no link (FR-032, FR-033) | `first-post.test.ts` (pure) |
| 17 | Dialogs: link only with `firstPostDone=false` and ≥ 1 ok row; it survives the prop flipping to `true` after refresh; absent when `firstPostDone=true` (US4, SC-004) | `Composer.test.ts` or a new dialog test with mocked actions (as `Composer.test.ts:9` already mocks them) |
| 18 | The compose action results are unchanged (FR-036) | `tests/integration/compose/actions.test.ts` unchanged and green |
| 19 | The guide is registered, in the nav, and linked from the card in full and collapsed forms (US5.1, FR-040, FR-046) | `published-docs.test.ts` (the new `docsUrl("getting-started")` call), plus `overview/ui.test.tsx` cases for full and `Setup complete` |
| 20 | The guide has no commands or env var names (US5.3, SC-006) | a test that reads `docs/getting-started.md` and rejects `` ``` `` fences, `pnpm `, `docker `, and `[A-Z][A-Z0-9]+_[A-Z0-9_]+` tokens |
| 21 | Switcher: `aria-keyshortcuts="Control+K Meta+K"`; the `<kbd>` is `aria-hidden="true"` (US6.1-2, FR-050-052) | render `ProjectSwitcher` with `next/navigation` mocked |
| 22 | Setup password described by its hint with and without an error; the hint stays visible (US6.3-4, FR-053-054) | render `SetupField` with and without `error` |
| 23 | Pinned nav labels unchanged (FR-060) | `tests/integration/failures/nav.test.ts` |

## 3. Final pass (once, at the end of implement)

```bash
pnpm lint < /dev/null && pnpm typecheck < /dev/null && pnpm test < /dev/null
pnpm build < /dev/null   # pages, a shared component and client/server boundaries changed
```

`pnpm db:check` isn't needed, because the schema doesn't change. Expected: all green.

SC-009: the only assertions that change are the `accounts-ui.test.ts` ones listed in research ("Corrections to the
spec's context"). Check with `git diff main -- tests 'src/**/*.test.*'`.

The strict mkdocs build isn't available locally (spec assumption). It runs in `.github/workflows/docs.yml` on the PR.
Report it as "verified by CI", not as run.

## 4. Browser walk-through (manual, real browser)

Run the app locally with the mock setup, as an owner, at desktop width and at 390 px:

1. **Accounts, no accounts**: connect a mock account. The page lands on its Posting slots heading, which sits below
   the sticky header, with the success message visible. Focus is on the Monday pill; Tab reaches Time, then Add slot.
   A screen reader (VoiceOver) announces the message. Reload: no message, no focus jump.
2. **Card order**: status, Posting slots, a closed "Posting instructions · None", then Remove behind a divider. Open
   instructions, save an over-long text: the section stays open with the error. Save valid text, then reload: it
   reads "· Set".
3. **Reconnect**: set the mock behaviour so the account needs reconnecting (or flag it in the DB), then follow the
   reconnect banner. The badge and Reconnect come first. Reconnect: the page lands on the card, focus is on the
   name, and the message says "Reconnected {name}."
4. **Generate with no voice profile**: a dashed SetupNotice titled "Before you can generate", with three rows.
   Batch jobs, New batch job and New batch job from CSV look the same.
5. **First post**: in a project with no scheduled posts, add a slot, compose, then Add to queue. The "Added to the
   queue" dialog shows "See it on the calendar"; follow it, and the calendar month contains the post. Compose a
   second post and Schedule it: no link.
6. **Overview**: the Getting started card shows "Read the getting-started guide" (it opens in a new tab), and still
   shows it when collapsed to "Setup complete".
7. **Switcher**: VoiceOver reads the project name only. Ctrl+K / ⌘K still opens it.
8. **`/setup`** on a fresh DB: the password hint is read with the field, and stays visible after a too-short
   password.
9. **As an editor**: the cards show no controls, and the instructions are read-only inside the disclosure. Generate
   shows "Waiting on {names}". The first-post link appears for the editor's first schedule.

Check at 390 px: nothing scrolls sideways, no console errors, focus rings visible. If the walk-through can't run,
say so in the implement output. Don't report it as done.

## 5. Docs check

- **`docs/getting-started.md`**: exists, follows the contracts/ui.md §5 outline, and is under 5 minutes to read
  (~900 words or fewer).
- **`mkdocs.yml`** and **`docs/index.md`**: list it first under "Using Docket". **`src/lib/docs.ts`**: has
  `"getting-started"`.
- **`docs/design-system.md` §7**: has the SetupNotice row. The Checklist row no longer mentions prerequisite lists and
  has `footer`.
- **`docs/accounts.md`**: the posting-instructions placement sentence is updated.
- **`docs/decisions.md`**: has the "033" section (FR-019, FR-062, the Intl note, the changed assertions). If the skill
  write was refused, it also has the docket-ui open item.
