# Quickstart: validating terminology, page descriptions and nav order

How to prove this entry works. Expected copy lives in [contracts/ui.md](./contracts/ui.md). Module shapes are in
[contracts/modules.md](./contracts/modules.md). Don't duplicate them here.

## Prerequisites

- The worktree is on branch `029-terminology-nav-order`. Dependencies are pre-installed, and no new package is
  needed.
- A Postgres for tests. `DATABASE_URL` points at it, as for every integration test. Test DBs are run-scoped.
- For the browser pass: the local mock setup (mock provider, mock LLM) used in the 027 and 028 walk-throughs.

## 1. Targeted tests (per task)

Run only what a task touches, for example:

```bash
pnpm vitest run tests/integration/terminology < /dev/null
pnpm vitest run tests/integration/failures/nav.test.ts tests/integration/overview/nav.test.tsx src/app/p/[projectSlug]/review/review.test.tsx < /dev/null
pnpm vitest run src/lib/roles/roles.test.ts src/components/ui/ui-atoms.test.ts < /dev/null
pnpm vitest run src/app/p/[projectSlug]/voice/voice.test.tsx < /dev/null
pnpm vitest run tests/integration/roles/routes.test.tsx tests/integration/jobs/ui.test.tsx < /dev/null
```

Expected: all green.

| Run | Should prove |
|---|---|
| `tests/integration/terminology/` | the scenarios below |
| the nav files | the pinned "Review (3)", ">Failures<" and Review-above-Failures checks still hold |
| `roles/routes.test.tsx`, `jobs/ui.test.tsx` | the "New batch job from CSV" strings |

## 2. Scenarios and what proves them

| # | Scenario (spec) | Proof |
|---|---|---|
| 1 | Nav lists 13 items in FR-001 order and groups, and the phone strip has the same order (US1.1, US1.5, SC-002) | `terminology/nav.test.tsx` reads link labels in DOM order. The strip and the sidebar are one list |
| 2 | "Review (3)", "Failures (2)", plain "Failures"; Review directly above Failures (US1.2-3, FR-002, FR-005) | `failures/nav.test.ts`, `review.test.tsx:142-146` (both pinned) |
| 3 | "Brand voice"/"Batch jobs" keep `/voice`/`/jobs`, are marked current there, and the heading and tab title use the new name (US1.4, FR-006, FR-007) | `terminology/nav.test.tsx` (`aria-current`); `page-headers.test.tsx` (heading, plus `metadata.title` / `generateMetadata`) |
| 4 | Every FR-012 page has one `<h1>` and its description (US2.1, SC-001) | `page-headers.test.tsx` via `expectPageHeader`, plus the per-route files listed in research R19 |
| 5 | Calendar in Europe/London: description "Scheduled posts and open posting slots, in Europe/London.", and the zone isn't in the title (US2.2, FR-016) | `page-headers.test.tsx`, Calendar case (project created with `timezone: "Europe/London"`) |
| 6 | Failures and Post detail keep `id="page-title"` with `tabindex="-1"` (US2.3, FR-014) | `page-headers.test.tsx` |
| 7 | Compose with no accounts shows the Compose header (US2.4) | `page-headers.test.tsx`, Compose case with no accounts |
| 8 | Invite form: owner sees 3 cards with Editor checked; admin sees 2 (US3.1-2, FR-050) | `terminology/roles.test.tsx` |
| 9 | Signup names "Editor" and shows the editor description in all 3 summary states; Invitations names "Admin" with the admin description (US3.3-4, FR-052, FR-053, SC-004) | `terminology/roles.test.tsx` |
| 10 | Posting-slot definition appears once with 2 accounts, for owner and editor, and not with 0 (US4.1, FR-020) | `page-headers.test.tsx` (or `terminology/accounts.test.tsx`) |
| 11 | Posts list shows "{account}: {label}" for all 7 target statuses, with no raw key (US4.2, SC-003) | posts-statuses case, plus the `ui-atoms.test.ts` enum sweep |
| 12 | Batch job page row reads "Accounts" (US4.3, FR-040) | `jobs/ui.test.tsx` "Job page", or the `page-headers.test.tsx` Batch job case |
| 13 | Voice editor hints in edit and read-only modes, linked by `aria-describedby` (US4.4, FR-060) | `voice.test.tsx` |
| 14 | `/p/new` sentence and linked time zone hint (US5.1-2, FR-070, FR-071) | `terminology/p-new.test.tsx` (or a case in `page-headers.test.tsx`) |
| 15 | No env var, command or email-derived name in new copy (SC-007) | the copy-guard case in `page-headers.test.tsx` |

## 3. Final pass (once, at the end of implement)

```bash
pnpm lint < /dev/null && pnpm typecheck < /dev/null && pnpm test < /dev/null
pnpm build < /dev/null   # pages and a shared component changed
```

`pnpm db:check` isn't needed: there's no schema change. Expected: all green. SC-006 means the only changed
assertions are the ones listed in research R19. Check with `git diff --stat -- tests src/**/*.test.*`.

## 4. Browser walk-through (manual, real browser)

Run the app locally with the mock setup. Then check, as an owner and as an editor, at desktop width and at 390 px:

1. **Nav**: it reads Overview / Publish: Compose, Calendar, Posts, Review, Failures / Create: Generate, Brand voice,
   Media, Batch jobs / Project: Accounts, Settings, Activity. On the strip, the current item scrolls into view.
2. **Every nav page**: one title and one muted sentence. Calendar shows the zone once. The tab titles say "Brand
   voice" and "Batch jobs".
3. **Accounts with an account**: the posting-slot line sits above the cards once.
4. **Members & invitations (owner)**: three role cards, keyboard-selectable with the arrow keys, each with its
   description. As an admin: two cards.
5. **Signup and Invitations**: open an invitation link and `/invitations`. The role reads "Editor" or "Admin", with
   its description.
6. **Voice profile**: the four hints, also shown read-only to an editor.
7. **`/p/new`**: the new sentence and time zone hint.
8. **Failures**: resolve or retry an item. Focus returns to the "Failures" heading as before.

Check that nothing scrolls sideways at 390 px (beyond the nav strip), there are no console errors, and focus rings
are visible. If the walk-through can't run, say so in the implement output. Don't report it as done.

## 5. Docs check

- **`docs/design-system.md` §6**: the diagram, the Sidebar bullet and Page anatomy match [contracts/ui.md](./contracts/ui.md)
  §1 and §2.
- **`.claude/skills/docket-ui/SKILL.md`**: the app-shell bullet and the PageHeader and role-source lines are there.
  If the sandbox refused the write, the open item is recorded in `docs/decisions.md`.
- **`docs/generator.md`**: it says "Batch jobs → New batch job from CSV".
- **`docs/decisions.md`**: it has the "029" section.
