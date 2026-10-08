# Research: Problem notifications

No external platform facts are involved, so nothing here comes from `docs/research/`. Every finding below was read from the code on `main` (at `03ffe93`) or from the installed package docs in `node_modules`. No `NEEDS RESEARCH` or `NEEDS CLARIFICATION` remains.

## Findings (what the code does today)

- **F1 — One insert site for events.** `createActivityRepo(...).insert` in `src/server/dal/activity.ts` is the only `insert(activityEvents)` in `src/` (grep). Every writer listed in 020's plan reaches it through `scope.activity` or `createSchedulingRepos(...).activity`. `seq` is `bigint GENERATED ALWAYS AS IDENTITY` (default `CACHE 1`). `occurred_at` is the caller's `clock.now()`, taken before the insert and often well before the commit.
- **F2 — The FK lock already exists.** `activity_events.project_id` references `projects.id`. Postgres takes `FOR KEY SHARE` on the referenced `projects` row in the FK check, which runs after the row (and its `nextval`) is formed. That lock is held until the writer commits.
- **F3 — The project lock already exists.** `scope.transaction(fn, { lockProject: true })` runs `SELECT id FROM projects WHERE id = $1 FOR UPDATE` as its own statement, then re-resolves the membership in a new statement (`src/server/dal/scope.ts`). `withLockedProject` (`src/server/dal/invitations.ts`) does the same for invitation accept and sign-up. Remove member, leave project, change role and transfer ownership all use it. `FOR UPDATE` conflicts with `FOR KEY SHARE`.
- **F4 — Membership inserts.** There are exactly three:
  - `createProject` (`src/server/dal/projects.ts`) inserts `member` directly, inside its own transaction;
  - `finishAccept` (accept by id or token) calls `tx.members.insert` under `withLockedProject`;
  - `signUp` calls `tx.members.insert` under `withLockedProject`.

  Removal is `members.delete` inside a `lockProject` transaction (`remove`, `leave`). The app has no project or user delete; both exist only as DB cascades (`member` → `organization` and `user`, both `ON DELETE CASCADE`).
- **F5 — `member` keys.** `member` has a unique index `member_organization_user_uidx (organization_id, user_id)`. That is a valid FK target. `lockSelf` takes `FOR NO KEY UPDATE` on the caller's own `member` row, which does not conflict with `FOR KEY SHARE`.
- **F6 — The problems URL is `?outcome=problems`.** `parseActivityFilter` sets `filter.preset = "problems"` only when the `outcome` parameter is exactly that one token. `filterToSearchParams` writes `outcome=problems`. There is no `preset` parameter: the spec's "`preset=problems`" is this URL. Cursors are the `before` / `after` parameters, and a malformed one silently means the first page.
- **F7 — Who renders the header.** `/p/[slug]/layout.tsx` renders `SignedInHeader`, so on `/p/[slug]/activity` the header (layout) and the page render concurrently in one RSC request. `/activity` and `/invitations` render `SignedInHeader` inside the page. `getSession` is wrapped in React `cache()`, so it runs once per request.
- **F8 — Proxy.** `src/proxy.ts` already rewrites request headers for every matched request (`x-nonce`, `Content-Security-Policy`) with `NextResponse.next({ request: { headers } })`. Its same-origin check refuses every non-GET request whose `Origin` is not the app's, before anything runs, so it covers server actions and route handlers. `loginRedirectFor` redirects any non-public path without a session cookie to `/login`.
- **F9 — Prefetching in Next 16.3.8.** Per `node_modules/next/dist/docs/01-app/02-guides/prefetching.md`, without Cache Components (not enabled in `next.config.ts`):
  - a dynamic route is not prefetched unless it has `loading.js`;
  - with `loading.js`, the prefetch covers the layout down to the first loading boundary;
  - `prefetch={false}` disables it per link.

  Both activity routes have `loading.tsx`, so an automatic prefetch renders the **project layout (and its header)** but not the page. The router marks its prefetch requests with `next-router-prefetch` and `next-router-segment-prefetch`; these names come from `node_modules/next/dist/client/components/app-router-headers.js`.
- **F10 — Scope harness.** `tests/helpers/scope-check.ts` treats a statement as pinned through:
  - `scope_column = $n`;
  - column-to-column joins between scope columns.

  Any `OR`, or any `NOT` other than `IS NOT NULL`, makes the whole `WHERE` unpinned. Inside `runForProjectSet`, every pin must bind one of the set's ids. `= ANY($n)` is not a pin.
- **F11 — UI pieces.**
  - **Reusable.** `Alert` takes `role` (`status` keeps it polite even for `warning`). `LiveRegion` is a polite status region. `ProviderIcon` and `Icon` are plain components that work on the server and the client. `LocalTime` gives the absolute time with the zone.
  - **Relative time.** The only relative-time code is the private `ago()` in `SchedulerHealth.tsx`.
  - **Patterns.** `Menu` shows the focus and Escape conventions. `AutoRefresh` uses `router.refresh()`, which re-renders the page; that is unusable here (see R9).
  - **Testing.** There is no jsdom or Testing Library, so client logic is tested as pure functions, as `nextMenuIndex` is.
  - **Icons.** `lucide-static` 1.52.0 has `bell.svg` and `sliders-horizontal.svg`.
- **F12 — Counting cost today.** The 020 indexes are:
  - `(project_id, occurred_at DESC, seq DESC)`;
  - `(project_id, outcome, occurred_at DESC, seq DESC)`;
  - a partial account index;
  - a partial target index.

  None of them can range over `seq` for one project.

## Decisions

### R1 — State lives in a new `notification_states` table, one row per membership

- **Decision**: a new project-owned table. The primary key is `(project_id, user_id)`, with a composite FK `(project_id, user_id) → member (organization_id, user_id) ON DELETE CASCADE`. It holds `seen_seq`, `seen_at` and `muted`. There is no per-event table.
- **Rationale**:
  - **Deletion (N8, FR-019).** Deleting the `member` row deletes the state in the same statement, so it happens in the removal or leave transaction and rolls back with it. Project and user deletion cascade through `member`.
  - **Rejoining.** A rejoin creates a new `member` row, and the old state is already gone.
  - **Role changes.** A role change updates `member.role` only, which is not a key column, so the state is kept.
- **Alternatives rejected**:
  - **Columns on `member`.** It is a Better Auth table. Marking would also update it, taking `FOR NO KEY UPDATE`, which conflicts with `lockSelf`'s upload serialisation.
  - **An FK to `member.id`.** It needs an extra column and still needs `project_id` for the scope harness.
  - **Per-event read rows.** Forbidden by FR-001.

### R2 — The position is `activity_events.seq`

- **Decision**: `seen_seq bigint` means "every attention event for this person in this project with `seq ≤ seen_seq` is read". Unread means `seq > seen_seq`. A row is "New" in the panel when its `seq > seen_seq`.
- **Rationale**: `seq` is assigned by one global identity sequence, so it is comparable across writers, and only R3's locking makes it exact. `occurred_at` is the writer's clock taken before the commit. It is also historical for the 0014 backfill, so a time marker would mis-order rows.
- **Alternatives rejected**:
  - **A time marker (`seen_at`) alone.** It swallows late commits whose `occurred_at` is before the mark.
  - **`(occurred_at, seq)` like the Activity cursor.** Same flaw.
  - **Transaction-id snapshots (`pg_current_snapshot`, an `xid8` column).** These are exact, but break across `pg_dump` and restore, which is how Unraid installs back up.

### R3 — Marking read is exact: writers lock the project row before `nextval`; marking waits them out

This resolves the P5 bound the spec asked about (Edge Cases; FR-005).

- **Writer side (one-line change).** `ActivityRepo.insert` first runs `SELECT 1 FROM projects WHERE id = $1 FOR KEY SHARE`, as its own statement, and then inserts.
  - The FK check takes this same lock anyway (F2). Taking it one statement earlier means it is held **before** the event's `seq` is drawn.
  - It is the same lock, on the same row, in the same transaction, so no new lock edge is added.
- **Marking side.** Marking is done in one transaction **per project**, with these statements in order:
  1. `SET LOCAL lock_timeout = '2s'`;
  2. `SELECT id FROM projects WHERE id = $1 FOR UPDATE`;
  3. re-check that the caller is still a member, in its own statement;
  4. `S` = the newest attention `seq` for this person in this project (R4: two O(1) index reads, `GREATEST`ed);
  5. upsert `seen_seq = GREATEST(seen_seq, S)`, `seen_at = now()`.
- **Why it is exact.** Take any event E for project P:
  - **E's writer locked P before the mark did.** `FOR UPDATE` waits until that writer commits. Step 4 is a later statement, so its new READ COMMITTED snapshot sees E, and E is covered. E was inserted before the mark took effect, so it "existed".
  - **E's writer locked P after the mark did.** Its `FOR KEY SHARE` blocks until the mark commits, and only then does it draw `nextval`. Sequences only increase, so `seq(E) > S`, and E counts as unread. This is the "committed afterwards" case.

  No transaction can hold P's key-share lock across the mark without being waited for.
- **Forward only (N3).** `GREATEST` keeps the later position whichever of two tabs commits first.
- **Deadlock freedom.** A mark transaction waits only once, for the project row, as its first lock, and then touches only its own `notification_states` row.
  - Every other writer of that row (membership removal through the cascade, another mark) takes the same project row first.
  - A multi-project writer (`claimDueTargets` inserting events for several projects) can wait on the mark, but the mark never waits on it while holding anything.
  - "Mark all as read" therefore runs one short transaction per project rather than locking several.
- **Lock timeout.**
  - **On timeout** (SQLSTATE `55P03`) nothing is marked.
  - **A view mark** ignores the timeout: the count simply stays.
  - **"Mark all as read"** reports the projects it could not mark.
  - **Mute and unmute** report "Could not save. Try again."

  The lock is transaction-scoped, so it is safe behind Neon's transaction-mode pooler.
- **Skipping the lock when nothing is new.** A cheap unlocked read first checks whether any visible attention event has `seq > seen_seq`. If none does, the mark does nothing, which is safe:
  - not moving the position can never swallow an event;
  - an in-flight event either was waited for by the mark that set the current position, or draws a larger `seq` than it.
- **Assumption recorded.** The identity sequence keeps `CACHE 1` (the default). A per-session cache would break "later `nextval` is larger" across sessions. The data model forbids changing it.
- **Alternatives rejected**:
  - **`LOCK TABLE activity_events IN SHARE MODE`.** It stalls every project's writers.
  - **A documented "may miss" bound like P5.** The spec's edge case requires that nothing is swallowed.
  - **A deferred trigger stamping a commit-time sequence.** It mutates the append-only log and still has a gap.
  - **`track_commit_timestamp`.** It is server configuration that Neon does not expose.

### R4 — Two small partial indexes on `activity_events`; the panel reuses the 020 index

- **Decision**: two new partial indexes.
  - `activity_events_attention_seq_idx ON (project_id, seq) WHERE outcome IN ('failed','ambiguous','needs_reauth')`;
  - `activity_events_connect_failed_actor_idx ON (project_id, actor_user_id, seq) WHERE outcome = 'connect_failed'`.
- **Queries**:
  - **Count.** Two range scans per project: `seq > seen_seq` on each index, the second also with `actor_user_id = $me`. Each is capped at `LIMIT 100`. The first index serves the member-wide kinds, the second the person's own connect failures.
  - **Newest position (R3 step 4).** `max(seq)` on each index, which Postgres answers with one index probe.
  - **Panel.** Uses the existing `(project_id, outcome, occurred_at DESC, seq DESC)` index, with **one branch per outcome** (equality on `outcome`). That makes each branch an ordered `LIMIT 10` read, sorted across branches, and joined for display only after the limit, as in 020's "limit before joining" fix.
- **Rationale**:
  - SC-003 (< 100 ms with 200,000 events across 20 projects) needs counting work bounded by the unread count, not by history.
  - Connect failures are rare, so the second index is tiny.
  - The outcome predicates are written as SQL literals from `lib/activity/outcomes.ts` constants, never parameters, so the planner can prove each partial index applies.
- **Alternatives rejected**:
  - **One partial index over all four outcomes.** Counting the three member-wide kinds would then need heap fetches to filter out `connect_failed`.
  - **A full `(project_id, outcome, seq)` index.** It is larger and needs a `GREATEST` over four probes.
  - **Reusing `list` with `outcome = ANY(…)` for the panel.** It sorts all of a project's problems before the limit.
- **Scope (FR-021).** These indexes are the only change to the log's schema.

### R5 — The count: one statement over the caller's set, membership and mute re-checked in it

- **Decision**: `countUnread` is a single statement, built per project as a `UNION ALL` of two branches. Each branch:
  - joins `member` for the caller (`member.organization_id = activity_events.project_id AND member.user_id = $u`), as 020's set reader does;
  - joins `notification_states` on `(project_id, user_id)` with `muted = false`;
  - pins `activity_events.project_id = $p`;
  - applies `seq > notification_states.seen_seq` and `LIMIT 100`.

  The outer query is `SELECT count(*) FROM (… LIMIT 100)`.
- **Where it runs**:
  - **The header and the refresh endpoint** run it through `forMyProjects` inside its project-set section, so every pin is checked against the caller's resolved ids (FR-004).
  - **The callout** runs the one-project form through `ProjectScope`.
- **Rationale**:
  - A removal, a mute or a project deletion committed during the request is honoured by the statement itself.
  - It has no `OR` (F10).
  - It stops at 100 (FR-003, N9).

### R6 — Starting points are written with the membership; the first deploy marks everything read

- **New members (FR-018).** `MembersRepo.insert` (the accept and sign-up paths, which hold the project lock) and `createProject` insert the state row in the same transaction as the `member` row:
  - `seen_seq` is the project's newest attention `seq` (R3 step 4);
  - for a brand-new project it is `0`;
  - `muted = false`.

  Because the lock is already held, the start is exact. A rejoin is a new `member` row, so it starts fresh.
- **First deploy (FR-020).** A custom migration inserts a row for every existing `member`:
  - `seen_seq` is the global `max(activity_events.seq)`, read once from the unique `seq` index (global ≥ per project);
  - `ON CONFLICT DO NOTHING`.

  An event in flight at that instant may be treated as read, which is what N7 asks ("up to that moment").
- **A missing row** (only possible for rows written outside the DAL, for example old test fixtures):
  - it counts nothing and lists as notifications on;
  - the next mark or mute creates it at the current position;
  - a test asserts that every membership path creates exactly one row.
- **Alternatives rejected**:
  - **Lazy creation on first read.** It writes during GET renders, and it cannot know the position at join time.
  - **A fallback to `occurred_at > member.created_at`.** It cannot use an index range, and it scans history.

### R7 — "Opening the problems view" means these exact URLs

- **Decision**: a view marks read when all of these hold:
  - the path is exactly `/p/{slug}/activity` or `/activity`;
  - `parseActivityFilter(..., lenient)` gives `preset === "problems"`;
  - there is no platform, account, range, from or to;
  - `invalidRange` is false;
  - neither `before` nor `after` is present.

  `/activity` covers the `project` filter's slugs that are in the caller's set, or every project in the set when there is none. A project-page slug outside the caller's memberships marks nothing.
- **Rationale**:
  - These are N4.2 and N4.3, on the URLs the app already produces (F6).
  - Other parameters, such as `_rsc`, are ignored because the filter parser ignores them.
  - No `preset` parameter is added (FR-021).
- **Pure function.** The rule is `problemsViewScope(pathname, searchParams)` in `src/server/services/notifications/view-mark.ts`, returning `null`, `{ kind: "project", slug }` or `{ kind: "all", slugs: string[] | null }`.

### R8 — The view mark runs once per request, before the header counts and before the page lists

- **Decision**:
  - `src/proxy.ts` forwards `x-docket-path` (the request's pathname plus search), overwriting any value a client sent, next to `x-nonce`.
  - A request-scoped helper, `ensureProblemsViewMarked()` in `src/components/notifications/request.ts` (server only, wrapped in React `cache()`):
    1. reads that header and the prefetch headers (R9);
    2. applies R7;
    3. calls the notifications service once.

    It is called by the bell, before it counts, and by both activity pages, before they list. Whichever runs first does the work, and the other awaits the same promise.
- **Rationale**:
  - On `/p/{slug}/activity` the header is in the layout and renders concurrently with the page (F7). Without a shared, awaited step the header's count could predate the mark, which would make the count wrong without JavaScript (FR-014).
  - Marking **before** listing means nothing is marked that the page did not show. An event committed between the mark and the list is shown and stays unread, which is the safe direction.
- **Alternatives rejected**:
  - **Marking in the page, plus a client "refresh now" nudge.** The no-JS header would be stale by one load.
  - **Marking in the proxy.** That would put database writes in the proxy.
  - **Having the layout parse search params.** Layouts do not receive them.

### R9 — Prefetches and preloads never mark

- **Decision**: `ensureProblemsViewMarked()` does nothing when the request has any of:
  - `next-router-prefetch`;
  - `next-router-segment-prefetch`;
  - a `sec-purpose` or `purpose` header containing `prefetch` (browser speculation and preload).

  Every link Docket renders to a problems view sets `prefetch={false}`. These are the panel's "View all", the callout, and the existing summary "problems" link in `ActivitySummary`.
- **Rationale**: an automatic prefetch of a route with `loading.tsx` renders the **layout**, and so the header (F9). The header is exactly where R8 marks, so the header guard is essential. `prefetch={false}` is the second layer.

### R10 — The bell is a link without JavaScript and a disclosure with it; the panel loads when opened

- **Without JavaScript.** The server renders the bell as `<a href="/notifications">` with:
  - the count badge;
  - the accessible name in screen-reader text.

  `/notifications` shows the same recent-problems list, "Mark all as read", "View all" and the mute controls. That is how the rows and links stay "reachable from the bell" (FR-014).
- **With JavaScript**:
  - **Trigger.** After mount the client component renders a `<button aria-expanded aria-controls aria-haspopup="dialog">` in the link's place.
  - **Opening.** Opening shows a non-modal panel (`role="dialog"`, labelled "Recent problems") directly after the button in the DOM, moves focus to its heading, and fetches `GET /api/me/notifications/recent`.
  - **Closing.** Escape closes the panel and returns focus to the button. A click outside or focus leaving the panel closes it.
- **Rationale**:
  - The panel is always fresh when opened.
  - Ordinary page loads do not pay for a 10-row query.
  - `router.refresh()` is never used. It would re-render the page and so re-mark a problems view the person is sitting on, against the spec's edge case.
- **Alternatives rejected**:
  - **`<details>` with a server-rendered panel.** It adds a query to every page, and the rows go stale while the count updates.
  - **Loading the panel with a server action.** Actions are POST-only and serialised, and Next's docs advise against using them to fetch data.

### R11 — Two session-only GET endpoints under `/api/me/`

- **The two routes**:
  - `GET /api/me/notifications` returns `{ count, display, label }`. This is the refresh (FR-015).
  - `GET /api/me/notifications/recent` returns the panel model.
- **What both do**:
  - authenticate with the session cookie through `getSession()` only;
  - answer `401 { "error": "unauthenticated" }` without one, which includes a request carrying only an API key;
  - read no query or body;
  - send `Cache-Control: private, no-store` and `Vary: Cookie`.
- **Auth gate.** `/api/me/` is added to `PUBLIC_PREFIXES` in `src/lib/auth-gate.ts`. The proxy then lets cookie-less requests through to the route, which answers 401 itself rather than redirecting a `fetch` to `/login`.
- **Rationale**:
  - These are not part of the public API: API keys belong to projects, not people (spec assumptions).
  - They are GET, so the same-origin rule does not apply. They have no CORS headers and the cookie is `SameSite=Lax`, so other sites cannot read them.

### R12 — The refresh loop is a small pure controller

- **Decision**: `src/components/notifications/poll.ts` exports pure, injectable logic:
  - `createBellPoller({ fetchCount, schedule, cancel, isVisible, onCount })`;
  - `nextAnnouncement(prev, next)`.

  The poller:
  - polls every 60 s while `document.visibilityState === "visible"`;
  - fetches once when the tab becomes visible again;
  - clears the timer while the tab is hidden;
  - on failure keeps the last value and stays silent;
  - fetches at once on a `docket:notifications-changed` window event, which is dispatched after "Mark all as read" and after a mute change.

  An announcement ("3 unread problems", polite) happens only when the count rises.
- **Rationale**:
  - The repo has no DOM test environment (F11). Pure logic with injected timers and visibility is testable under Vitest's `node` environment, like `nextMenuIndex`.
  - No dependency is added.

### R13 — Mutations are server actions over the caller's own resolved projects

- **The actions**:
  - **`markAllRead`** (`src/app/notifications/actions.ts`): with JavaScript it returns an `ActionResult` to the panel; when its form carries `returnTo=/notifications`, it redirects there with `?marked=1`.
  - **`setNotifications`** (the same file): takes `projectSlug` and `on`, and redirects to `/notifications?changed={slug}`.
  - **`setMyProjectNotifications`** (`src/app/p/[slug]/settings/actions.ts`): redirects to `/p/{slug}/settings?notifications=on|off`.
- **Scoping (FR-009).**
  - The services resolve the slug only within `forMyProjects(session)` (the set) or `forProject(session, slug)` (the project settings page).
  - An unknown slug and someone else's project both raise `NotFoundError`, which shows as the same generic "That project could not be found." and changes nothing.
  - No action accepts a user id.
- **Forgery.** The proxy's same-origin check (F8) refuses cross-site POSTs before they run, on top of Next's own action origin check.
- **Accepted `returnTo`.** Only the literal `/notifications` (no open redirect).

### R14 — Muting UI: one form per project, one submit button, state shown as text

- **Decision**: each project row shows:
  - its name;
  - a `Badge` reading "On" (success) or "Off" (neutral);
  - a secondary button "Turn off" or "Turn on", whose accessible name is "Turn off notifications for Acme".

  This needs no JavaScript and has a visible label (FR-008). The confirmation is an `Alert tone="success"` (`role="status"`) driven by the redirect's query parameter, for example "Notifications for Acme are off. Its problems still appear in Activity."

  The project settings page gets a separate `Card` titled "Your notifications" with the same control. It is visible to every role and sits outside the owner/admin `SettingsForm` (N10).
- **Alternatives rejected**:
  - **A checkbox or switch that auto-submits.** It needs JavaScript.
  - **A `SegmentedControl` plus a Save button.** That is two steps per project on a list.

### R15 — The callout is a polite warning `Alert` on the project home and Posts screens

- **Decision**: `ProblemsCallout` (a server component) renders nothing at zero or when muted. Otherwise it renders `Alert tone="warning" role="status"`:
  - title "Problems since you last looked";
  - the text "2 problems" (capped at "More than 99 problems");
  - the link "View problems" → `/p/{slug}/activity?outcome=problems` with `prefetch={false}`.

  It appears at the top of `/p/[slug]/page.tsx` and `/p/[slug]/posts/page.tsx`.
- **Rationale**: `role="status"` keeps it polite (FR-017). Note that most screen readers do not announce a status region that is present at load. The callout's place first in `<main>` is what makes it found. This is recorded in the docs, not over-promised.

### R16 — A `RelativeTime` atom, from the existing `ago()` wording

- **Decision**:
  - A pure `relativeTimeText(at, now)` moves to `src/lib/time/relative.ts`. It keeps `SchedulerHealth`'s wording: "45 s ago", "12 min ago", "3 hours ago", "4 days ago".
  - `SchedulerHealth` imports it. The behaviour is unchanged, and the existing tests guard that.
  - A new atom, `src/components/ui/RelativeTime.tsx`, renders `<time dateTime title={absolute in zone}>12 min ago<span class="sr-only">, {absolute}, {zone}</span></time>`. The absolute part uses `formatLocal` from `LocalTime` plus the IANA zone name.
  - The panel and the Notifications page use it. The server passes `now` from `clock.now()`; the client passes `new Date()`.
- **Rationale**: FR-011 wants the absolute time and zone "available as text", that is, a tooltip and screen-reader text, as the assumptions say.

### R17 — What does not change

- No new runtime or dev dependency, environment variable, infrastructure, webhook type, API operation, key permission or `docker-compose.yml` change. No change to event kinds, messages, filters or `/api/v1/activity`.
- The two activity pages only gain the shared mark call (R8). `ActivitySummary` only gains `prefetch={false}` (R9).
- `.claude/skills/docket-ui/SKILL.md` is outside the pipeline's writable paths. Adding `/notifications` and the bell to its Structure list is **owed to the operator**, as it was for 020. `docs/design-system.md` carries the new atoms and the header change.
