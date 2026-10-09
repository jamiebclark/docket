# Quickstart: validating the project overview

These steps prove the feature works end to end. Rules and copy are in `data-model.md` and `contracts/`. They aren't
repeated here.

## Prerequisites

- Node 24, pnpm, and a local Postgres with `DATABASE_URL` set (as for every integration test).
- No new env vars. No migration.
- For the browser walk-through: `pnpm dev` with the mock provider enabled, as in the existing local mock setup. You can
  leave the AI provider and storage unconfigured to see the server-setup row.

## Automated checks (per task, then once at the end)

```bash
# Pure rules: every step state, roles, names, server-setup items, attention items, collapse (SC-005)
pnpm vitest run src/lib/overview/derive.test.ts

# Service facts against real Postgres: seeded data, removal and re-expansion, no emails in output (SC-003, FR-017)
pnpm vitest run tests/integration/overview/service.test.ts

# Page and sections markup for owner and editor, empty and populated; title; loading files (SC-002/003/004/008)
pnpm vitest run tests/integration/overview/ui.test.tsx

# Nav: Overview first, exact match, exactly one current item (SC-006); existing pins unchanged (SC-007)
pnpm vitest run tests/integration/overview/nav.test.tsx tests/integration/failures/nav.test.ts "src/app/p/[projectSlug]/review/review.test.tsx"

# Docs links still resolve to real pages and headings
pnpm vitest run tests/integration/docs/published-docs.test.ts
```

The implement phase's final pass is `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. The build is needed
because the route moved into a group and the loading boundaries changed. `pnpm db:check` isn't needed, since the schema
doesn't change.

**Expected**: everything passes. The two pinned nav tests pass without being edited.

## Scenarios to see in the markup tests

| # | Setup | Expect |
|---|---|---|
| 1 | New project, owner, no accounts | Title "{name} · Docket". Description "Times in UTC. You're an Owner.". One primary action, "Connect an account". The checklist comes first, with step 1 "To do" and steps 2 and 3 "To do" plus "Needs an account first" |
| 2 | + a mock account without slots | Step 1 "Done". Step 2's action links to `#account-{id}-slots`. Step 3's action is "Write a post". The primary action is "Write a post" |
| 3 | + an active slot and a scheduled post | The checklist is one line, "Setup complete" (or hidden when no optional step is open and there's no server-setup row) |
| 4 | Remove the account | The full checklist comes back. Nothing to clear |
| 5 | Editor, empty project, owner "Robin" and admin "Sam" | "Waiting on Robin and Sam" on steps 1, 2 and (with AI) 4. Accounts empty: "No accounts yet. Ask Robin or Sam to connect one." No invite step. No email, no `LLM_`/`S3_`/`*_CLIENT_ID` names, no `pnpm`/`docker` text, no connect, reconnect or slot actions |
| 6 | Owner, scheduler never ran, AI and storage off | "Server setup" row with three items, each linking to its docs page. The admin and the editor see no row |
| 7 | 2 in review, 1 ambiguous target, 1 failed, 1 needs reconnecting, 1 expiring in 10 days | Needs attention lists all five with badges and links (editor: no reconnect link, "Ask … to reconnect it."). Plus "See all activity" |
| 8 | 7 scheduled posts | Coming up shows 5, soonest first, with times in the project zone and account names, plus "Open calendar" |
| 9 | AI and storage on, 0 voice profiles, 3 images and 1 video | Content tools: "No voice profile yet. Generated posts need one." and "4 images and videos" |
| 10 | `/p/acme`, `/p/acme/calendar`, `/p/acme/settings/members` | Exactly one `aria-current="page"`: on Overview, then Calendar, then Settings |

## Browser walk-through (run by the implementer, via chrome-devtools MCP)

1. Sign in as the owner of a fresh project. Open `/p/{slug}` and check scenario 1 visually. Open the tab title.
2. Follow each checklist action once and check that each lands where the step is done, in one click (SC-001).
   Connect a mock account, add a slot from the anchored editor, then write and schedule a post. Come back after each
   step and see it read "Done".
3. Resize to 390 px wide. The header actions stack, the cards are one column, and nothing scrolls sideways (SC-009).
   Run `document.documentElement.scrollWidth <= innerWidth` in the console.
4. Keyboard only: Tab through the page. Every action and the "Setup complete" summary show a focus ring, and the
   summary opens with Enter or Space without JavaScript (check once with JavaScript disabled).
5. Sign in as an editor of the same project and repeat step 1 against scenario 5.
6. Throttle the network, navigate to the home and see the skeleton. Navigate to Settings and see the generic loading
   state, not the overview skeleton.

Record anything that only ran with mocks as "verified with mocks only" in the implementation outcome (Constitution II).
