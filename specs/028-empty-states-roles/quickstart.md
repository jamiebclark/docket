# Quickstart: validating empty states and role awareness

This guide covers how to prove the entry works. The expected copy and rules are in [contracts/ui.md](./contracts/ui.md).
The derived values are in [data-model.md](./data-model.md). The function signatures are in
[contracts/services-and-modules.md](./contracts/services-and-modules.md).

## Prerequisites

- Run from the worktree, with Postgres running for the integration tests (the usual `DATABASE_URL`). Test databases
  are scoped to each run.
- No real credentials are needed. AI uses `setLlmForTests(createFakeLlm([]) | null)`, storage uses
  `setStorageForTests(createMemoryStorage() | null)`, the scheduler uses `writeHeartbeat` or clears
  `schedulerHeartbeats`, and accounts are mock accounts (`postsEnv().account(settings, withSlot)`).
- Role fixtures: `createProjectWithMembers()` gives one owner, one admin and one editor. For the spec's names, create
  the users with `createUser({ name: "Robin" })` and `createUser({ name: "Sam" })`, then `addMember` them.

## Automated checks

Run these per task, scoped to what changed (constitution: "Run checks in proportion").

```sh
pnpm vitest run src/lib/roles src/lib/overview 'src/app/p/[projectSlug]/compose' < /dev/null
pnpm vitest run tests/integration/roles tests/integration/overview tests/integration/scheduler-health.test.ts < /dev/null
pnpm vitest run tests/integration/accounts-ui.test.ts tests/integration/failures tests/integration/jobs/ui.test.tsx < /dev/null
pnpm vitest run 'src/app/p/[projectSlug]/review' 'src/app/p/[projectSlug]/generate' 'src/app/p/[projectSlug]/voice' src/components/shell < /dev/null
pnpm vitest run tests/integration/docs/published-docs.test.ts < /dev/null   # every new docsUrl anchor exists
```

The implement phase ends with a final pass: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm build` (server and
client props change).

## Helper for "nothing privileged" (FR-080, SC-002)

Add `tests/helpers/role-copy.ts`:

```ts
expectNoPrivilegedText(html, { emails })
```

It fails if `html` contains any of:

- an env var name (`/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/`);
- `docker`, `/api/internal` or `<code`;
- any of the members' `email` values;
- a connect or slot or voice-create link (`accounts#add-account`, `#account-…-slots`, `/voice/new`).

Each route's editor test calls it.

## Scenarios (one test or more each)

| # | Scenario | Setup | Expect |
|---|---|---|---|
| 1 | Editor sweep (US1, SC-002) | Owner Robin, admin Sam, an editor. No accounts, voice, AI or heartbeat | Every route in contracts/ui.md, rendered as the editor, names "Robin" and/or "Sam" where it asks, and passes `expectNoPrivilegedText` |
| 2 | Accounts by role (US1-1, US4-1/2) | No accounts. Meta env unset | Owner: the FR-001 manager copy, configured options first, then a closed `<details>` "Not set up on this server (n)" with `connect-group-meta-redirect` inside. Admin: no "Not set up on this server". Editor: "No accounts yet. Ask Robin or Sam to connect one.", with no `id="add-account"` |
| 3 | Calendar states (US4-3/4/5, edge cases) | (a) no accounts; (b) one account, no slots, empty period; (c) the same with a post in the period; (d) one active slot, a past week | (a) no "Calendar navigation" nav, with "Connect an account" for the owner. (b) the toolbar is present, and "Add posting slots" links to `#account-{id}-slots` (editor: "No posting slots yet. Ask Robin or Sam to add some."). (c) the grid and the one line. (d) "No posts or open posting slots in this period." and "Today", with no `/accounts` link |
| 4 | Compose slot hint (US3, FR-081) | `Composer` rendered with a `check` that can schedule, and accounts with `hasActiveSlot` false, mixed, true or null | `all`: Add to queue is disabled with `aria-describedby` the hint, and Schedule… is the last button and `cta`. Owner gets the link; editor gets "Ask … to add some.". `some`: "Beta has no posting slots, so Add to queue can't place it." `true` or `null`: no hint, and today's buttons |
| 5 | Compose page wiring | An integration test renders `ComposePage` with an account whose only slot is paused | The `Composer` props carry `hasActiveSlot: false` (assert on the rendered hint once a check result is provided, or on the props through a module mock) |
| 6 | Posts (US5-1/2) | No posts, then one draft with `?status=published` | No `Filter posts by status`, "Write a post" button-styled. Then the tabs, and "No posts match this filter." with "Show all posts" |
| 7 | Failures (US5-3/4) | No posts, then a published post, then a filter | "Posts that fail to publish will show up here." with no counts line or tabs. Then today's copy with "View posts". Then "Clear filters" |
| 8 | Review (US5-5/6) | Empty queue | The FR-033 copy and `href="/p/{slug}/generate"`, button-styled |
| 9 | Generate list (US2, FR-082) | All three missing; then AI and an account only; then everything | One `<ol>` with the three titles in order, per role as in contracts/ui.md. Partial: Done, Done, To do. Everything: the form (`<form`) and no "Before you can generate" |
| 10 | Job pages (US2-6, FR-082) | No LLM. Media selection empty | New job from media: four items, including "Images to generate for" with "Back to Media". CSV: three items. Both: no form |
| 11 | Jobs list (US6-6/7, FR-044–046) | Ready and empty; not ready with one job | Ready: "New job from CSV" primary, "Choose images in Media" secondary, and the FR-045 copy with no links in the empty state. Not ready: the Checklist above the table, and no header actions |
| 12 | Media (US6-1/2/3) | Storage off; storage on and empty; items but none unused | Off: owner "Set up storage" to the storage docs, editor "Ask Robin to set it up.". Empty: only the dropzone and the FR-050 copy, with no `role="search"` and no "Filter media". None unused: an info alert with the same text |
| 13 | Voice (US6-4/5) | None; only archived | None: no "Include archived", and a button-styled "Create a voice profile" for the owner. Editor: "No voice profile yet. Ask Robin or Sam to create one.". Only archived: tabs shown |
| 14 | Scheduler banner (FR-083) | `stale` and `never`, × owner, admin and editor | Owner: today's remedies and a link to `…/deployment/#9-is-the-scheduler-running`. Admin and editor: "Scheduled posts are not going out. Ask Robin to start the scheduler.", with no `<code>`, `RUN_WORKER_IN_PROCESS` or `TICK_SECRET` |
| 15 | Reauth banner (FR-063) | One account needing reauth, editor | "Ask Robin or Sam to reconnect it." |
| 16 | No names | Every owner and admin has a blank name (set with an update) | The copy falls back to "an owner or admin" or "an owner", and never shows an email |
| 17 | Pinned nav (FR-075, SC-007) | Unchanged tests | `tests/integration/overview/nav.test.tsx`, the LeftNav tests and `generate/policy.test.tsx` pass without edits |

## Manual browser walk-through (SC-006, SC-008)

Run this against `pnpm dev` with the mock provider and no AI or storage configured. Use the chrome-devtools MCP
recipe in the browser-validation memory.

1. Sign in as the owner of an empty project. On each touched route, Tab to the empty-state action. Check that the
   focus ring is visible and that the action looks like a button, not underlined text.
2. Open Accounts, expand "Not set up on this server" with the keyboard (Enter or Space on the summary), and collapse
   it again.
3. Resize to 390 px. On Accounts (expanded), Calendar, Compose (with the slot hint), Generate, Jobs and Media, check
   that `document.documentElement.scrollWidth <= 390`.
4. Sign in as an editor in the same project and repeat the route sweep. Nothing offers an action the editor can't
   take.

Record the walk-through's outcome in the implement phase's output. If it can't be run, say so: Constitution II
forbids claiming it worked.
