# Quickstart: validating problem notifications

This guide proves the feature end to end. Shapes are in [data-model.md](./data-model.md), interfaces in [contracts/](./contracts/), and the reasons in [research.md](./research.md). Nothing needs real platform credentials: events are written through the real DAL (`ActivityRepo.insert`) or by the mock provider, against real Postgres. Nothing here makes a live platform call.

## 0. Prerequisites

- Node 24 and pnpm. Dependencies are already installed; no new package is needed.
- Postgres 17 for tests (run-scoped test databases, as for every suite).
- After the schema change:
  1. `pnpm db:generate` creates `0015_*`, with the table and the two partial indexes.
  2. `pnpm drizzle-kit generate --custom --name notification_states_start` creates `0016_notification_states_start.sql`. Paste in the SQL from data-model §3.
  3. `pnpm db:check`.
- After adding `bell` and `slidersHorizontal` to `scripts/generate-icons.mjs`: `pnpm icons`.

## 1. Targeted test map (run per task)

```bash
pnpm vitest run <files below>
```

| Requirement | Test file (new unless marked) | Proves |
|---|---|---|
| N9, FR-010, FR-017 copy | `src/lib/notifications/text.test.ts` | `unreadDisplay` for 0, 1, 99, 100 and 150 (`""`, `"1"`, `"99"`, `"99+"`, `"99+"`). `unreadLabel` for 0, 1, 3 and 100. The callout text. The mute confirmations. |
| N1 | `src/lib/notifications/attention.test.ts` | `isAttentionFor` across all 7 kinds. Connect failed counts only for its actor; a null actor counts for nobody. |
| R7, R9, FR-006 | `src/server/services/notifications/view-mark.test.ts` | These qualify: `/p/a/activity?outcome=problems`, `/activity?outcome=problems`, `/activity?outcome=problems&project=a&project=b`, and an extra `_rsc` param. These do not: `outcome=problems,published`, `outcome=failed`, plus `platform`, `account`, `range`, `from` or `to`, `before` or `after` (even malformed), `/p/a/activity/x`, `/activity/`, an unfiltered view. `isPrefetch` for `next-router-prefetch`, `next-router-segment-prefetch`, `Sec-Purpose: prefetch;prerender` and `Purpose: prefetch`; a normal RSC navigation (`rsc: 1`) is not a prefetch. |
| R12, FR-016 | `src/components/notifications/poll.test.ts` | With fake timers and visibility: polls at 60 s while visible; none while hidden; one immediate fetch on becoming visible; one on `docket:notifications-changed`; a failure keeps the last count and does not announce; an announcement only on increase (2→3 yes, 3→3 and 3→1 no). |
| R16 | `src/lib/time/relative.test.ts`; existing `tests/integration/scheduler-health.test.ts` | Same wording as before (`45 s ago`, `12 min ago`, `1 hour ago`, `3 hours ago`, `4 days ago`). `SchedulerHealth` output unchanged. |
| FR-002/003/004, SC-004/005, US1 | `tests/integration/notifications/count.test.ts` | User U in projects A and B. Events of all 7 kinds, some by U and some by another member V, before and after U's position: the count equals exactly the attention events after the position. V's connect failure is not counted for U but is for V. A null-actor connect failure counts for nobody. Muting B removes B; unmuting gives 0 for B (N6). A project U is not in contributes nothing. 150 unread gives 100, with the work stopped at 100 (assert on `LIMIT` in the recorded SQL). |
| FR-005, N3, R3, Edge Cases | `tests/integration/notifications/mark-read.test.ts` | See §2 for the concurrency cases. Also: two marks commit in either order and the position ends at the later one; a mark never lowers `seen_seq`; with nothing new, no `FOR UPDATE` is issued (statement recorder). |
| N4, FR-006, US3 | `tests/integration/notifications/view-mark.test.ts` | Pages rendered with `next/headers` mocked to supply `x-docket-path`. `/p/a/activity?outcome=problems` marks A only. `/activity?outcome=problems` marks A and B; with `&project=a` it marks A only. Problems plus a platform, account, date or `before` marks nothing. Unfiltered Activity marks nothing. The same URLs with `next-router-prefetch: 1` mark nothing. Rendering the project **layout** alone for that URL with the prefetch header marks nothing. The header count rendered in the same request is already 0 for A. A problem inserted after the render counts. |
| N4.1, FR-012, US2-AS5 | `tests/integration/notifications/mark-all.test.ts` | `markAllRead` covers muted and unmuted projects; returns `busy` for a project whose lock is held (lowered timeout); the `returnTo=/notifications` redirect; no `returnTo` returns a result without redirecting. |
| FR-007/008/009, US4 | `tests/integration/notifications/mute.test.ts` | Default on for a new membership. Muting B hides B from U's count, panel and B's callout, while B's events still appear in both Activity screens for U, and V's count for B is unchanged. Unmuting after problems gives 0, and a later problem gives 1. An editor can mute from settings. A slug U is not in, and a slug that does not exist, give the same `not_found` and change no row. No session redirects to login. |
| FR-015, US7, SC-004 | `tests/integration/notifications/routes.test.ts` | Calls both route handlers directly with `getSession` mocked. No session gives 401 with `no-store`. An expired session (real Better Auth session row with a past `expires_at`, through `helpers/auth.ts`) gives 401. A `Bearer` API key only gives 401. A user in no projects gives `{0, "", "No unread problems"}` and `state: "no_projects"`. Crafted `?userId=` and `?project=` and a body are ignored. Responses carry `Cache-Control: private, no-store` and `Vary: Cookie`. `recent` returns ≤ 10 items, newest first, with the right `isNew`, links, "Removed account" and no `details`. `src/lib/auth-gate.test.ts` (extended): `/api/me/notifications` is not redirected. |
| FR-004, R5 | `tests/integration/notifications/scope.test.ts` | With the scope recorder: every count, recent and unread-projects statement is in a project-set section and each pin is in U's set. A per-project repo pins its project. `write` with a foreign project id throws before any SQL. A member removed mid-request is excluded by the statement's own `member` join (remove between resolve and count). |
| FR-018/019/020, US6, SC-006 | `tests/integration/notifications/membership.test.ts` | Project creation creates a row with `seen_seq` 0. Accept by id, accept by token and sign-up each create exactly one row at the project's newest attention `seq`: 20 earlier problems give 0, and one later gives 1. Remove and leave delete the row in the same transaction. A forced failure after `members.delete` (a throwing audit stub), and the last-owner refusal, leave the row intact. Deleting the project or the user removes it. Rejoining starts fresh with notifications on. A role change keeps the row. The next count and panel after removal exclude the project. |
| FR-020 | `tests/integration/notifications/start-migration.test.ts` | Seeds members and events; runs `drizzle/0016_*.sql` twice; every member gets one row with `seen_seq = max(seq)` and a count of 0; re-running adds nothing; an event written afterwards counts 1. |
| FR-010–014, FR-017, SC-007 | `tests/integration/notifications/ui.test.tsx` | `renderToStaticMarkup` of: the bell at 0 (no badge, "No unread problems"), 1, 3 and 150 ("99+", "More than 99 unread problems"), rendered as `<a href="/notifications">`. `NotificationList` with "New" on unread rows only, a group connect failure with two platform names, "Removed account", "Post deleted", the three link targets, and `RelativeTime` sr-only text with the zone. The empty variants (`no_projects`, `all_muted`, no items). `/notifications` page: table with `th scope`, per-project button names, confirmations, no-projects empty state. Settings card for an editor. `ProblemsCallout` shown (2, and "More than 99"), hidden at 0, hidden when muted; `role="status"`; link `prefetch` off. `SignedInHeader` order: Invitations, bell, user menu with "Notifications". |
| SC-003 | `tests/integration/notifications/performance.test.ts` | §4. |
| Regression (existing, unchanged) | `tests/integration/activity/*.test.ts`, `tests/integration/members.test.ts`, `invitation-accept.test.ts`, `tests/helpers/scope-check.test.ts` | Activity lists, summaries and the API are byte-for-byte the same. Events still write with the extra `FOR KEY SHARE`. Membership flows unchanged. |

## 2. Concurrency cases (mark-read.test.ts)

Use two pooled connections (as `tests/integration/lock-recheck.test.ts` does) and the lowered lock timeout hook.

1. **A writer started before the mark is covered.**
   - Writer W opens a transaction, inserts a failed event through `ActivityRepo.insert`, and holds the transaction open.
   - Start the mark for U. Assert it is waiting (`pg_stat_activity` / `pg_locks` shows a lock wait).
   - Commit W. The mark completes, `seen_seq ≥ seq(W)`, and the count is 0.
2. **A writer started after the mark counts.**
   - The mark transaction takes the project lock, with a pause injected after step 2 through a test hook.
   - W starts `ActivityRepo.insert` and blocks on `FOR KEY SHARE`.
   - Release the mark and let it commit; W then completes.
   - The count is 1, and `seq(W) > seen_seq`.
3. **A held lock makes the mark give up.**
   - W holds the project lock for longer than the lowered timeout.
   - The view mark returns without error and `seen_seq` is unchanged.
   - `markAllRead` reports the project as busy.
4. **No deadlock with a multi-project writer.**
   - A transaction inserts an event for A, then one for B, while marks run for A and B concurrently.
   - Everything completes with no `40P01`.

## 3. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm db:check          # schema changed
pnpm build             # new routes, a proxy change, server/client boundary
```

## 4. SC-003 method (performance.test.ts)

- **Seed** with `generate_series` (as 020's `performance.test.ts` does):
  - 100,000 events in one project;
  - 200,000 events across 20 projects for user U, mixed outcomes with about 15% problems;
  - U's positions half-way through each project;
  - five projects muted.
- **Assert**, each measured as the median of 5 runs after one warm-up:
  - `unreadSummary(set)` under 100 ms;
  - the `GET /api/me/notifications` handler under 100 ms;
  - `recentPanel(set)` under 100 ms.
- **Log** `EXPLAIN (ANALYZE, BUFFERS)` for the count statement. Assert it uses `activity_events_attention_seq_idx` and `activity_events_connect_failed_actor_idx`, with no sequential scan of `activity_events`.

## 5. Manual walk-through (not claimed as run by the pipeline)

1. `docker compose up`, sign in as the owner, and create projects A and B. The bell is present with no count.
2. With the mock provider, schedule a post to an account set to fail.
   - Within 60 s the bell shows 1 without a reload, and the screen reader says "1 unread problem".
   - Hide the tab for two minutes: the network panel shows no `/api/me/notifications` calls. Show it again: one call at once.
3. Open the bell with the keyboard: focus lands on "Recent problems", the row is marked "New", and Escape returns focus to the bell. Choose the row: it opens the Failures entry.
4. Open A's home: the "Problems since you last looked" callout shows 1. Follow it: Activity with Problems opens, the bell count drops to 0, and the callout is gone on the next visit.
5. On `/notifications`, turn A off. The confirmation shows. Fail another post in A: no count, but it is in Activity. Turn A on: the count stays 0.
6. Disable JavaScript and reload. The bell is a link to `/notifications` with the right count; "Mark all as read" and the Turn on/off buttons work and confirm.
7. Invite a second user to A after several failures. On first sign-in their bell has no count.
8. Remove them. Their next page load or refresh shows nothing from A.

## 6. Docs to check

- **`docs/activity.md`**: a new "Notifications" section covering:
  - what counts (N1, N2), what marks read (N4) and muting (N5, N6);
  - starting points (N7);
  - the 60-second refresh, which stops while the tab is hidden;
  - delivery outside Docket using webhooks, linking to [`n8n.md`](../../docs/n8n.md).
- **`docs/decisions.md`**: `## 022`, with spec decisions N1–N12 and plan decisions R1–R17 (written in the plan phase).
- **`docs/design-system.md`**:
  - §6 header: the bell between Invitations and the user menu, and the user-menu "Notifications" link;
  - §7: `RelativeTime`, `NotificationList`, `ProblemsCallout`, and the bell.
- **README**: the feature list mentions the bell.
- **Owed to the operator**: `.claude/skills/docket-ui/SKILL.md` Structure list (`/notifications`, the bell), which the pipeline cannot write.
