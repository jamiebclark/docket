# Quickstart — how to run this feature and prove it works

Validation guide only: what to run, and the check that proves each user story. Implementation detail
lives in [data-model.md](./data-model.md) and [contracts/](./contracts/); task order is `tasks.md`.

## 0. Prerequisites

```bash
pnpm install                 # already installed in pipeline phases; the registry is unreachable there
docker compose up -d postgres
pnpm db:migrate              # applies 0021 (the preferences table + the muted data migration)
pnpm dev                     # http://localhost:3000
```

Tests need a real Postgres (`DATABASE_URL`, and `DATABASE_URL_DIRECT` for the migration test, which
creates and drops its own database). Nothing here needs provider credentials, network access or
`MOCK_PROVIDER_ENABLED` — except the one case that asserts a `mock` switch is never offered while it is
off.

## 1. Per task

```bash
pnpm vitest run tests/integration/notifications/<file>.test.ts
pnpm vitest run src/lib/notifications/eligibility.test.ts
pnpm typecheck                      # when types changed
pnpm lint <changed files>
```

## 2. Once, at the end of the implement phase

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm db:check                       # the schema changed: migrations and schema must agree (FR-023)
pnpm build                          # a route's rendering and the server/client boundary changed
node scripts/check-contrast.mjs     # no new colour pairing, but the grid is new markup
```

## 3. The checks that prove each story

| Story | Run | Passes when |
|---|---|---|
| **US1** — hear about the problems I can act on | `preferences.test.ts` | With one unread event of each of the four kinds, turning one kind off drops the count by exactly those events; the panel omits them; the callout's number matches; both Activity screens are unchanged; another member's count is unaffected; all four off makes the project contribute nothing and read as off in words; a person with no row at all behaves exactly like today's unmuted project. |
| **US2** — stop hearing about a platform | `preferences-platforms.test.ts` | Events on two platforms, one platform off → only the other counts. A platform whose accounts are all removed keeps its switch listed and off and keeps excluding its past events. A platform with accounts and no switch is listed and on. A platform with neither is absent, and an account connected on it later counts with nothing written. A connect failure across Facebook+Instagram counts **once** with either on, and not at all with both off. An event with no platform is governed by its kind alone — asserted on the pure rule and by running the §4.3 expression against `ARRAY[]::text[]`, because the log's `CHECK` makes a zero-platform row unreachable (Q22). |
| **US3** — no backlog | `preferences-fresh-start.test.ts` | With a kind off, 150 events of that kind are written; turning it on gives 0 and the next event gives 1. Same for a platform switch and for "Turn all on". Switching **off** marks nothing read (other kinds' counts unchanged). An individually read or snoozed event whose kind goes off and on again does not count and leaves no mark. At the 200-mark cap, an on-write prunes the redundant marks and row actions come back. "Mark all as read" or a problems view while a kind was off keeps everything below the floor hidden afterwards. Two concurrent on-writes never lower the position; an event committed just after the switch still counts. |
| **US4** — set it from one place, or from the project | `ui.test.tsx` | The grid renders one row per project with four kind switches, the platform disclosure and the project controls; every control's accessible name names the project and the switch; a change saves, confirms by name and re-renders the new state; every control is a plain form post (no `onClick`, no client component) so it works with JavaScript unavailable; the tab order is name → kinds → all-off → all-on → Platforms → platform switches; an editor sees and can submit the settings card; a person in no project sees the empty state; a renamed project's labels follow the new name. |
| **US5** — nobody else's switches | `preferences-authz.test.ts` | Every mutation with: no session, an expired session, a session naming another member's user, a session naming a project the caller does not belong to, a session naming a project that does not exist, and a public-API key. Each is refused, nothing is written, and the two project cases give the identical "not found". Removing a membership deletes the preferences in the same transaction; a rolled-back removal (last owner) leaves them; deleting the project or the user takes them with it. The project-scope harness passes (`tests/helpers/scope-check.ts`). |
| **US6** — an existing install upgrades | `mute-migration.test.ts` | On a database built from the committed migrations: rows seeded with `muted = true` and `muted = false`, non-zero `seen_seq`, `seen_at` values and sparse marks. After 0021, every muted row has all four kinds off and reads as off; every unmuted row has no preference row and reads as fully on with an unchanged count; every `seen_seq`, `seen_at` and mark is byte-identical; a person who had muted and then turns one kind on starts fresh from that moment; the migration needs no operator step; `pnpm db:check` is green. Modelled on `marks-migration.test.ts`, which already builds and drops its own database. |

Plus the anti-drift check (Q4), in `preferences.test.ts`: over a seeded matrix of events and every
combination of switches, the count the database returns equals the count `mayNotify` returns for the
same events.

## 4. Performance (SC-007)

`performance.test.ts`, extended rather than replaced: the existing 100 000-events-in-one-project and
200 000-across-20-projects seed gains a second person who has all four kind switches stored and **every**
platform switched off — the pathological case for the platform clause (Q7). The count, the refresh route
and the panel must each stay under 100 ms (median of 5 after a warm-up) for both people. If the new case
misses the budget, the fallback named in Q7 is a GIN index on `activity_events (provider_keys)`.

## 5. By hand, last (roadmap rule: browser and visual-judgement work goes last)

With `pnpm dev` and two accounts in the same project:

1. On `/notifications`, turn *Needs reconnecting* off for one project with the keyboard alone. The
   confirmation names the project and the switch; the bell's number drops by exactly those events.
2. Open the project's Activity — the events are all still there.
3. Open the Platforms disclosure with `Enter`, turn one platform off, and check the summary's count.
4. Use "Turn all off", then "Turn all on": the bell stays at zero for that project until the next
   problem.
5. Repeat steps 1 and 3 with JavaScript disabled in the browser (DevTools → Settings → Debugger →
   Disable JavaScript), including opening the disclosure.
6. As an editor who cannot change project settings, change every switch from
   `/p/<slug>/settings`.
7. Narrow the window to a phone width and check each row still reads as labelled "kind: On/Off" lines.
