# Roadmap: notifications that reach people

Goal: finish the notification story `022-problem-notifications` deliberately left half-built. That feature shipped a
header bell, an unread count, a recent-problems panel, a per-project mute and a per-project callout — but it only
notifies a person who is already signed in and looking, it treats every problem as one undifferentiated stream, and it
cannot be dismissed one item at a time. Its own "Out of Scope" list (`specs/022-problem-notifications/spec.md:300-307`)
names the four gaps, and this roadmap closes all four, in dependency order.

Source: `specs/022-problem-notifications/` (spec, data model, contracts, review) and decisions **N1–N12** in
`docs/decisions.md`. Read both in full before specifying any entry — several entries deliberately *reverse* a shipped
decision, and the spec phase must know which one it is overturning and why. Behaviour on `main` that every entry
builds on:

- **`notification_states`** (`src/server/db/schema/notifications.ts:10`) is one row per membership, keyed
  `(project_id, user_id)`, holding `seen_seq` (a monotonic bigint watermark: every attention event with
  `seq <= seen_seq` is read) and `muted`. A composite FK to `member` cascades the row away with the membership. The
  table comment states the N3 invariant outright: "never one row per event".
- **Attention events** are decision N1: activity outcomes `failed`, `ambiguous` and `needs reauth`, plus
  `connect failed` only for the member who attempted it. Kinds and their outcomes live in
  `src/lib/activity/outcomes.ts` (`ACTIVITY_KINDS`, `KIND_OUTCOME`); successes, retries and resolutions never count.
- **Reads** go through `src/server/dal/notifications.ts` — `newestAttentionSeq`, `createNotificationsRepo(db,
  projectId, userId)` for one project and `createNotificationsSetReader(db, projectIds, userId)` for the
  all-projects case (the one sanctioned cross-project reader).
- **Routes**: `src/app/api/me/notifications/route.ts` (the 60-second count poll, N12) and
  `.../recent/route.ts` (the panel's latest 10). The personal `/notifications` page
  (`src/app/notifications/page.tsx`, `actions.ts`) lists every project with an on/off control (N10).
- **Components**: `src/components/notifications/` — `NotificationBell(.tsx|Client.tsx)`, `NotificationPanel`,
  `NotificationList`, `NotificationToggle`, `NotificationsChanged`, `ProblemsCallout`, `poll.ts`, `request.ts`.
- **Invitation delivery is already behind an interface**, exactly as `docs/build-prompt.md:85` promised:
  `InvitationDelivery` / `defaultInvitationDelivery` in `src/server/services/invitations/delivery.ts:16-21`, injected
  at `src/server/services/invitations/index.ts:67`. Docket has **no mailer of any kind** today.
- **All-or-none env groups** follow `STORAGE_GROUP` in `src/server/env.ts:72-88`: setting any member of the group
  requires all of them, and setting an optional satellite without the group is an error.
- **The worker tick** (`/api/internal/tick`, `WORKER_INTERVAL_SECONDS`, `RUN_WORKER_IN_PROCESS`, budgets in
  `src/server/scheduler/config.ts`) is the only recurring server-side execution Docket has.

Rules for every entry:
- Must leave the repo working and say what it does **not** do, and which later entry owns it.
- When an entry reverses a shipped decision (N1–N12), say so explicitly, record the replacement in
  `docs/decisions.md` next to the original, and state what happens to data written under the old rule.
- Every schema change ships as a committed SQL migration with `pnpm db:check` green, and must be safe to apply to a
  live install with existing rows — no entry may require an operator to reset notification state.
- Keep project isolation: project-owned queries stay pinned to one project, or go through the named cross-project
  reader. The test harness fails any other query on a project-owned table.
- Role-aware: every member role manages their own notification settings (N10); nothing here is owner-only except
  server configuration, which links to docs rather than printing commands or env var names to non-owners.
- Prefer existing primitives (PageHeader, Card, Field, Button, Badge, Alert, Dialog, EmptyState, LiveRegion,
  LocalTime, Skeleton, buttonStyles). Follow the docket-ui skill and `docs/design-system.md`; full keyboard use,
  labelled controls, screen-reader announcements only on meaningful change (N12).
- Secrets never leak: SMTP credentials, signed unsubscribe tokens and recipient addresses are never logged, never in
  error messages, never in attempt summaries. The secret-scan test must stay green.
- Any task needing a browser, a screenshot or a visual judgement call goes **last** in `tasks.md`, after everything
  automated. An early human-gated task starves the implement loop.

## Entries, in order

1. **Per-event read state and snooze.** Reverses decision N3 (one forward-only watermark per project, no per-event
   rows) and N2's "a problem stays unread until you mark the project read". Let a person dismiss one problem, or
   snooze it until later, without touching the rest. Keep `seen_seq` as a **floor** — everything at or below it is
   read, "Mark all as read" still just bumps it — and add a sparse per-event table above the floor for individually
   read and snoozed events, so row growth stays bounded and the floor can absorb and prune the sparse rows. That
   bound is the point of the entry: N3 avoided per-event rows for cost reasons, and this must not reintroduce them
   unbounded. A snoozed problem leaves the count and the panel until its time passes, then returns unread; snoozing
   is personal and never hides the event from Activity (N5's spirit). Define what a snooze means for an event whose
   target has since been retried or resolved, and what happens when the floor rises past a snoozed event. Update the
   count query, `createNotificationsRepo`, `createNotificationsSetReader`, both `/api/me/notifications` routes, the
   panel rows (per-row "Mark read" and "Snooze", keyboard reachable, announced through the LiveRegion) and
   `ProblemsCallout`. Tests: counting with a mix of floor-read, individually-read, snoozed and expired-snooze events;
   pruning when the floor rises; concurrent mark-read from two tabs; snooze expiry at a DST boundary; membership
   removal still deleting everything; project isolation. Not included: per-kind or per-platform preferences
   (`notification-preferences`), any email (`email-delivery`), replacing the poll (`realtime-updates`), notifications
   for successes or retries (not in this roadmap at all — N1 stands).

2. **Per-kind and per-platform preferences.** Replace the single per-project `muted` boolean with preferences a
   person can set per attention kind (the four from N1) and per platform, with the project level becoming a roll-up:
   "all off" is the old mute, and the UI must still offer that one-click. Migrate every existing `muted = true` row
   to all-kinds-off so no one's choice is lost, and say in `docs/decisions.md` what `muted` becomes (kept as a
   derived column, or dropped). Preferences gate the bell count, the panel, the callout and — once `email-delivery`
   lands — what is eligible to be mailed, so the shape settled here is the shape email consumes. Keep N6's
   fresh-start rule: turning a kind back on marks that kind read at that moment rather than delivering a backlog.
   Extend `/notifications` (`src/app/notifications/page.tsx`) from a list of on/off toggles into a per-project grid,
   keep the same control on each project's settings page for every member role, and keep both usable with no client
   JavaScript. Tests: migration of muted rows, counting under each preference combination, per-platform filtering
   against accounts that were later removed, the fresh-start rule, defaults for a new member and a new project, and
   authz (a person may only edit their own preferences). Not included: **quiet hours** — that is a delivery-timing
   rule with no meaning for an in-app badge, and `email-delivery` owns it; any email; changing which outcomes are
   attention events (N1 stands); real-time transport.

3. **Email delivery.** Give Docket its first mailer and use it to deliver problems to people who are not signed in.
   A `Mailer` interface mirroring `InvitationDelivery` in shape, a default SMTP implementation, and an all-or-none
   SMTP env group following `STORAGE_GROUP` (`src/server/env.ts:72-88`) — with email **off** when the group is unset,
   exactly as media is off without S3, and a startup validation issue if a satellite variable is set without the
   group. Per-user choice of immediate or a daily digest at a chosen local hour, honouring the preferences from
   `notification-preferences` and the read/snooze state from `per-event-read-state` (never mail a problem the person
   has already read, dismissed or snoozed — the digest is assembled at send time, not queued per event). Quiet hours
   belong here: within them, immediate mail defers to the next allowed hour rather than being dropped. Digests run on
   the existing worker tick, inside its budget, with per-user send bookkeeping that survives a crash and never
   double-sends. Every email carries a one-click unsubscribe that works without a login (a signed, scoped,
   expiring token — never a bare user id) and lands on a page explaining exactly what was turned off. A delivery log
   in the shape of the webhook delivery log (`src/server/services/webhooks/deliver.ts`, `src/server/dal/webhooks.ts`)
   records attempts, failures and bounces without storing message bodies. Retrofit `defaultInvitationDelivery` so
   invitations are emailed when SMTP is configured and fall back to today's copy-the-link flow when it is not, and
   update `docs/build-prompt.md:85`, `docs/accounts.md:44` and `.env.example` accordingly. Tests: the env group
   (all-or-none, satellite-without-group, off-when-unset), immediate vs digest selection, quiet-hours deferral across
   DST and across time zones, no-double-send under a crashed and retried tick, read/snoozed/preference-filtered
   events excluded, unsubscribe token signing and expiry plus tamper rejection, bounce handling, invitation fallback
   both ways, and that no SMTP credential or recipient address reaches a log line. Not included: push or chat
   delivery (webhooks still cover automation — `docs/n8n.md`), notifications for successes, per-event actions inside
   the email beyond unsubscribe, and real-time transport.

4. **Real-time updates.** Replace N12's 60-second poll with a server push so a problem appears in the bell within
   seconds. Server-Sent Events over one authenticated endpoint, carrying the same payload shape the count route
   returns after `per-event-read-state` changed it; `poll.ts` and `NotificationBellClient.tsx` become a fallback that
   still works when the stream cannot connect, and the count must still render server-side with no client
   JavaScript at all. The deployment constraints are the entry's real content, not an afterthought: Docket is a
   single container behind a reverse proxy that may buffer or time out long-lived responses, may run several web
   processes, and `RUN_WORKER_IN_PROCESS` means the writer may not be the process holding the connection — so decide
   and record how an event reaches every connected process, how many connections one install will hold, what happens
   when the cap is reached, and how the stream is closed on sign-out, session expiry and membership removal. Document
   the proxy configuration it needs (`docs/deployment.md`). Tests: auth and project scoping on the stream, a client
   that reconnects after a dropped connection without missing or double-counting events, fallback to polling when
   SSE is unavailable, the connection cap, teardown on sign-out and on membership removal, and no leak of another
   person's counts. Not included: Web Push or service workers (a separate problem — OS-level delivery, VAPID keys
   and a service worker lifecycle — not in this roadmap), changing what is counted or who is notified, and any
   change to email cadence.
