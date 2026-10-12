# Implementation Plan: Real-time updates — a push stream for the problems bell, with the poll kept as its fallback

**Branch**: `061-realtime-updates` | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/045-realtime-updates/spec.md`

## Summary

Replace N12's 60-second poll with a push, and keep the poll as the thing that happens when the push
cannot. One new Route Handler, `GET /api/me/notifications/stream`, holds a `ReadableStream` and writes
Server-Sent Events — which is the installed framework's own documented way to do it
(`node_modules/next/dist/docs/01-app/02-guides/streaming.md:484`). Every message is the whole payload
`GET /api/me/notifications` already returns, produced by the **same** `unreadSummary()` call, so the bell
cannot disagree with itself (N68, constitution IV). No table changes, no environment variable, no
dependency, no infrastructure. One additive index.

**Delivery is discovered, never notified.** No process messages another. Each web process runs **one**
watcher for all of its connections — a single sequential loop that probes nine install-wide scalars every
2 seconds through the named `crossProject()` escape hatch, then recomputes the summaries of **its own**
connections when something moved or a connection's own `nextChangeAt` has passed, and sends only those
whose value changed (N71, FR-008–FR-012). That answers all three deployment constraints at once: the
writer never has to find the holder, so `RUN_WORKER_IN_PROCESS`, a worker container and an external cron
tick are all irrelevant to delivery; several web processes need no coordination, no shared memory and no
sticky sessions; and nothing joins the stack — no Redis, no queue, and no Postgres `LISTEN`, which the
constitution forbids because Neon's pooler is in transaction mode.

**The fingerprint is the whole correctness argument for delivery, so it is written out rather than
implied.** `max(seq)` over attention-outcome events, plus a row count **and** a `max(updated_at)` for each
of `notification_states`, `notification_preferences` and `notification_event_marks`, plus a count and
`max(created_at)` for `member`. The count is what sees a deletion; the instant is what sees an in-place
change; and `member` needs no `updated_at` because all three roles hold `post: view`, so a role change
cannot change who counts (`src/server/auth/access.ts:11, 28, 43`). Two small things make it sound: **one
new partial index**, `activity_events (seq) WHERE outcome IN (…four attention outcomes…)` (migration
`0023`), so the event scalar is a single-row index-only scan and a *successful* publish starts no round
(S15); and **one line changed** in `src/server/dal/notifications.ts`, where a floor move stamps
`updated_at` from the web clock instead of `now()` — harmless until something compares those instants,
which this feature does (S16).

**Snapshots, not increments, are why reconnection needs no protocol.** Every message is the person's whole
current count. The server sends one on connect and on every reconnect; it sends no event id, so the browser
sends no `Last-Event-ID`; there is no replay buffer, no cursor and no server-side event log. "Did I miss
anything" is answered by the payload rather than by a mechanism that has to be got right under load
(N69, FR-005).

**Three layers, and exactly one of them running at a time.** The server-rendered count stays the floor,
correct with no client JavaScript at all (022 FR-014). `poll.ts` is **not edited** — not its interval, its
visibility rule, its in-page change event, its `nextChangeAt` one-shot, its silent failure handling or its
tests; what changes is only who starts it (N79, FR-019). A new pure module,
`src/components/notifications/refresh.ts`, is the supervisor: five states (`hidden`, `connecting`,
`streaming`, `polling`, `ended`) out of which FR-019's "exactly one mechanism" falls, the per-tab fallback
memory, the backed-off attempt limit, the opening-snapshot deadline, the 2-second yield after a local
change and the announce-only-on-a-rise rule measured against one baseline shared with the poll.

**Two places where `EventSource` cannot tell the client *why*, answered without reaching for a status
code.** A refusal at the process cap is a 200 `text/event-stream` carrying one `unavailable` event and
then a close — recognisable as "poll instead" with nothing to inspect, holding no connection and carrying
no count (S7, FR-014). A 401 is learned from one request to the **existing** count route after a failed
connect: 401 means the session is gone, so stop and do not poll a signed-out endpoint (FR-021); 200 means
the stream's own failure and hands back a fresh count for free (S12).

**A held connection is a held authorisation decision, and it is re-checked.** The session is re-resolved
on every recompute and at least once a minute by a read-only `SELECT` on the `session` row — never by
`auth.api.getSession`, which would refresh a session whose new cookie a response already in flight cannot
deliver (S20, FR-022). Verified against the installed Better Auth 1.7.7: sign-out deletes that row, and a
refresh updates it in place. Memberships are not cached at all: every recompute goes through
`forMyProjects()` afresh, so losing a project drops its problems from the next push and never ends the
stream (FR-024).

**What this entry does not do.** Web Push and service workers (outside this roadmap by the author's own
words — no service worker is registered and no notification permission is asked for); anything about what
is counted or who is notified (N1, N13–N15, N39 are imported unchanged); anything about email (N42–N67);
and pushing anything other than the count — no live rows, no live Activity, no live queue, no live
Failures screen. This is the roadmap's last entry, so none of it is handed on.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19.2, Next.js 16.3.8 (App Router,
standalone output)

**Primary Dependencies**: **none added.** `drizzle-orm` 0.45 (`drizzle-orm/node-postgres`) for the probe
statement, Better Auth 1.7.7 for the session read, `zod` 4 at the boundaries that have input (the stream
has none). The browser side is the built-in `EventSource`: no package, no polyfill, no service worker. The
`NEEDS DEPENDENCY: nodemailer` mark that entry 3 carried has no counterpart here.

**Storage**: Postgres. **No new table and no new column.** One migration, `0023`: a single additive
partial index, `activity_events (seq) WHERE outcome IN ('failed','ambiguous','needs_reauth',
'connect_failed')`, which is what makes the watcher's event scalar O(1) and attention-only (S15). No
`UPDATE`, no `ALTER`, no data step, no operator action; a reading floor, a sparse mark and a preference row
are all untouchable by it. Everything a connection knows lives in that one process's memory for at most
4.5 minutes and is never shared or persisted.

**Testing**: Vitest. Integration against a real Postgres in `tests/integration/notifications/`
(`stream-*.test.ts`), driving the route handler directly the way `routes.test.ts` already does
(`vi.mock("@/server/auth/session")` plus `actAs`) and reading the response's `ReadableStream` with a
helper that decodes SSE frames. Pure unit tests with no DOM and no database for the protocol codec, the
registry's caps, the watcher's decide-what-to-send logic and the whole client state machine, over injected
environments exactly as `poll.ts` is tested today. The project-scope harness
(`tests/helpers/scope-check.ts`) governs every statement the stream makes. The migration gets a
self-contained test on its own database (the `marks-migration.test.ts` pattern). Nothing opens a socket to
anything external, so nothing here is "verified with mocks only"; the one visual walk-through is the last
task in `tasks.md` (roadmap rule).

**Target Platform**: self-hosted Docker Compose (web + worker + postgres), a container host with Neon, and
one or several web processes behind the operator's own reverse proxy. No session-level Postgres features.
The design is indifferent to whether the worker runs in-process, in its own container or as an external
cron.

**Performance Goals**: SC-001/SC-002 — a problem, a snooze expiry, a read elsewhere or a membership
removal reaches an open visible tab in **under 5 seconds** (one 2-second probe plus one recompute).
SC-004 — the watcher's per-probe database work is identical with 1 connection and with 50; per-person
counts are recomputed only on an actual change; on an install with 10 open tabs and a quiet hour the
per-person count queries fall from 600 an hour to **zero**, against a fixed 1,800 one-statement probes an
hour per web process. A round at the 50-connection cap is ≈70 sequential indexed statements at a bound of
3 concurrent, well inside the 2-second interval (S22). Full arithmetic in [research.md](./research.md) §2.

**Constraints**: the message body is exactly `UnreadSummary` — `count`, `display`, `label`,
`nextChangeAt` — from the one `unreadSummary()` the count route calls, and carries no problem row, event
id, project name, account name, platform key, message text or address (FR-003, FR-004). Responses are
`private, no-store` with `Vary: Cookie`, plus `Content-Encoding: identity` because the installed Next
*would* gzip a `text/event-stream` otherwise (verified, S2) and a buffering gzip stream is the one failure
mode N77 exists to catch. 50 streams per web process and 5 per person are constants, never settings
(FR-013). A connection lives at most 4.5 minutes, deliberately under the 300-second read timeout that is
the common proxy and Node default, so a scheduled close never races a timeout (S18). Every project-owned
query is pinned to one project or goes through the one sanctioned project-set reader; the one install-wide
statement goes through the named `crossProject()` escape hatch (FR-007).

**Scale/Scope**: 1 new route handler, 1 new shared protocol module, 3 new server modules (registry,
watcher, connection) plus 1 service entry point, 2 new tiny DAL readers, 1 new client module, 1 migration,
edits to 3 existing files (`NotificationBellClient.tsx`, `NotificationPanel.tsx`, and one line of
`src/server/dal/notifications.ts`), about 11 test files and 3 docs. `poll.ts`, `NotificationBell.tsx`, the
two existing `/api/me/notifications` routes, `eligibility.ts`, the DAL's notification repo and set reader,
every schema file and every scheduler section are **not** edited.

## Constitution Check

*GATE: checked before Phase 0 and re-checked after Phase 1 design.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| I. Verified facts over memory | **Pass, with nothing marked** | Every external fact is read from the installed packages and cited: Route-Handler streaming from `node_modules/next/dist/docs/01-app/02-guides/streaming.md:484-535`; the fact that `next start` compresses every response unless `compress: false`, that its bundled `compressible` has no `text/event-stream` entry, and that `Content-Encoding: identity` is its documented pass-through, from `node_modules/next/dist/server/lib/router-server.js:123-126, 257-265` and `node_modules/next/dist/compiled/compression/index.js`; sign-out deleting the `session` row and a refresh updating the same row from `node_modules/better-auth/dist/api/routes/sign-out.mjs` and `dist/db/internal-adapter.mjs:410-414, 451-485`; `keepAliveTimeout` only being set on the flag from `node_modules/next/dist/server/lib/start-server.js:248-249`. Everything else is read from this repository: `connect-src 'self'` (`src/lib/http/security-headers.ts:17, 28`), the three roles' `post: view` (`src/server/auth/access.ts`), the pool default (`src/server/env.ts:305`), the existing partial indexes (`src/server/db/schema/activity.ts`), the `globalThis` singleton pattern (`src/server/scheduler/in-process.ts:5-7`) and the write paths that stamp `updated_at` (`src/server/dal/notifications.ts`). **Two things are explicitly *not* asserted** because the installed docs do not document them: that `request.signal` aborts on client disconnect, and that `ReadableStream.cancel()` fires on a dropped socket. The design works without either (S19), and uses them only as best-effort fast paths. No proxy product is described anywhere; `docs/deployment.md` states requirements (FR-030). |
| II. Nothing is "working" unless it ran | **Pass** | Every functional requirement has a Vitest check: the route against real Postgres with real `session` rows, the caps and the watcher's decisions as pure logic, the whole client state machine against an injected `EventSource` double, and the migration on its own seeded database ([quickstart.md](./quickstart.md) §3-§4). No test opens a socket to anything external and nothing needs a credential, so there is nothing to report as "verified with mocks only". The 5-second latency claim (SC-001) is measured in a seeded test, not asserted. The one by-hand visual walk-through is the final task in `tasks.md`. |
| III. Project isolation in one place | **Pass** | No new table, so `projectOwnedTables` is unchanged. Every per-person recompute goes through `forMyProjects()` — the one sanctioned cross-project reader — which resolves memberships and compiles preferences afresh on **every** call and never caches them for the life of a connection (FR-022, FR-024); inside it every statement already runs in `runForProjectSet` with each branch pinned to one project id and re-joining `member`. The single install-wide statement, the fingerprint probe, goes through the named `crossProject("notifications stream: install probe")` escape hatch exactly as housekeeping, health and the scheduler already do, and touches no per-person data: it reads four aggregates and one `max(seq)`. The session re-check reads `session`, which is in `notProjectOwned`, under its own named reason. The route handler imports no database client. A test asserts those are the only two cross-project reasons the stream produces and that the harness sees no unpinned project-owned statement (FR-007, US4 §7). |
| IV. One service layer, many callers | **Pass** | The stream calls `unreadSummary(await forMyProjects(session))` — the identical expression `GET /api/me/notifications` uses — so there is exactly one implementation of "what is the person's count" and the bell cannot disagree with itself (FR-003). What may be counted is `src/lib/notifications/eligibility.ts`, imported unchanged (FR-006). Every interval, deadline and cap lives in one shared module both the server and the client import, so the deadline the client enforces and the heartbeat the server sends cannot drift (S32). The panel still fetches its own rows from the route it already uses (FR-027). |
| V. Providers are plug-ins | **Pass** | Nothing under `src/providers/` is touched, nor the publish path, the scheduler, the composer or any schema a provider sees. A platform added later appears in the count through the existing eligibility rule with no change here. |
| VI. Boring, few dependencies | **Pass, nothing to justify** | No runtime dependency, no queue, no Redis, no second process, no new infrastructure, no `docker-compose.yml` change, no `next.config.ts` change, no new environment variable and no new UI primitive — no new visible control exists to need one (FR-029, FR-033, SC-010). The transport is a built-in browser API and a framework feature. Capacity is grown by running another web process, which the design already supports with no coordination (N74). |
| VII. Secrets never leak | **Pass** | A message body is four fields of a count. Nothing on the stream carries a project name, an account name, a platform key, a message, an event id or a person's address (FR-004), and the panel keeping its own row fetch is what makes it structurally impossible for a stream message to carry one project's problem text to somebody who has just lost that project (N68). The endpoint reads **no** input at all — no query parameter, header or body — so there is nothing to craft (FR-002). The session token is never read, logged or stored: the connection holds a session **id** and re-checks it with a read-only `SELECT` (S20). Responses are `private, no-store` with `Vary: Cookie` and can never be shared. A probe failure and a recompute failure log a message only, rate-limited to one a minute, and never a parameter, a user id or a count. |
| Engineering: no session-level Postgres features | **Pass** | No advisory lock, no `LISTEN`, no `SET`-per-session state, nothing that assumes a sticky backend. The probe is one read-only `SELECT`; the recompute reads only. Everything works through a transaction-mode pooler because nothing outlives a statement. |
| Engineering: UTC and Temporal | **Pass** | This entry resolves no wall-clock time and introduces no date arithmetic. `nextChangeAt` is the absolute instant entry 1 already resolved and stored (M8); the watcher only asks whether it has passed. Clock skew can therefore only make a snoozed problem return one probe interval late, never early (spec Edge Cases). The fingerprint compares its tuple for **equality**, never order, and S16 puts every notification write on the database's clock so a skewed web clock cannot hide a change. |
| Engineering: bounded, concurrent-safe, kill-safe | **Pass** | This is not scheduler work and adds no section to `runTick()`; it is a per-process loop that starts with the first connection and stops with the last (S23), guarded by a `Symbol.for` singleton so a hot reload cannot start two. It is sequential, so rounds never overlap; it bounds recomputes at 3 at once against a pool of 10 (S22); a probe failure or a recompute failure is caught and retried next round and never closes a connection (S24); and `SIGTERM` closes every connection cleanly with a `reconnect` message, which is what makes a deploy indistinguishable from an ordinary reconnect. A connection that is killed mid-write deregisters itself, because every write is guarded (S19). |
| Engineering: accessibility, server components | **Pass** | No new screen, no new control, no visual change. The bell stays server-rendered first and the count stays correct with client JavaScript unavailable, with every link and "Mark all as read" working (FR-018). The only client code is the existing bell and panel plus one new pure module with no DOM. The live region, the announce-only-on-a-rise rule and one baseline shared between the stream and the poll are what keep a screen reader from hearing a reconnect (FR-025, N70, R15). A heartbeat changes nothing on screen and announces nothing (FR-016). Focus handling, keyboard behaviour and labels are untouched; `docs/design-system.md` needs no change and the `docket-ui` skill needs no new entry. |
| Workflow: migration ships committed, `db:check` green | **Pass** | One migration, `0023`, one `CREATE INDEX` on a partial predicate. Pure additive DDL: no data step, safe on a live install with existing rows, no operator action, and nobody's notification state is reset or altered. `pnpm db:check` must be green and a self-contained migration test runs it on a seeded database. |
| Workflow: docs | **Pass** | FR-030/FR-031/FR-032: `docs/deployment.md` §7 gains what the stream needs from a proxy — buffering off for it, a read/idle timeout above the heartbeat, HTTP/1.1 or better with no response transformation — in that section's existing "what must be true, not per-product recipes" voice, plus the install's ceiling (50 × web processes), the HTTP/1.1 six-connections-per-origin note, and the plain statement that an install whose proxy cannot be changed still works on the 60-second fallback. `docs/activity.md:78` is rewritten from "every 60 seconds" to the push, its automatic fallback and the fact that no setting controls either. `docs/decisions.md` records **N68–N84** next to N12, N39, R10, R11, R12 and R15, with the N12 reversal in place — the poll half replaced, the announcement half standing, and nothing to migrate because N12 stored no data — plus the plan decisions **S1–S32**. |

**No violations, and nothing marked.** The Complexity Tracking table below is empty. The one new index is
argued in S15 and is not a constitution exception; the two undocumented framework behaviours the design
refuses to rely on are named in S19 rather than assumed.

## Project Structure

### Documentation (this feature)

```text
specs/045-realtime-updates/
├── spec.md              # Input
├── plan.md              # This file
├── research.md          # Phase 0: no marked gaps, and plan decisions S1-S32
├── data-model.md        # Phase 1: the index, the fingerprint, the in-memory entities, the invariants
├── quickstart.md        # Phase 1: how to run it and the checks that prove each story
├── contracts/
│   ├── stream.md        # The wire: endpoint, headers, the five events, refusals, status codes
│   ├── server.md        # Registry, watcher, connection, the two DAL readers, ordering, failure rules
│   └── client.md        # The state machine, its environment, the bell and panel changes, announcements
├── checklists/          # Existing
└── tasks.md             # Phase 2 (/speckit-tasks) - NOT created here
```

### Source code (repository root)

```text
src/
├── lib/notifications/
│   ├── stream-protocol.ts        # NEW  pure: path, 5 event names, frame codec, every interval and cap (S32)
│   ├── stream-protocol.test.ts   # NEW  round trip, unknown event, malformed frame, no id/retry emitted
│   ├── eligibility.ts            # unchanged, imported (FR-006)
│   └── types.ts                  # unchanged: UnreadSummary is the message body
├── server/
│   ├── dal/
│   │   ├── notifications.ts            # ONE LINE: write()'s upsert stamps updated_at from now() (S16)
│   │   ├── notification-probe.ts       # NEW  readChangeFingerprint(db): the nine scalars, one statement
│   │   └── sessions.ts                 # NEW  sessionIsLive(db, { sessionId, userId }): read-only, no refresh
│   └── services/notifications/stream/
│       ├── registry.ts           # NEW  per-process connections, the two caps, displacement (pure over a clock)
│       ├── registry.test.ts      # NEW  process cap, per-person cap, oldest displaced, deregistration
│       ├── watcher.ts            # NEW  the loop: probe, decide, bounded recompute, failure rules
│       ├── watcher.test.ts       # NEW  no-change rounds, due instants, probe failure, concurrency bound
│       ├── connection.ts         # NEW  one connection: writes, heartbeat, lifetime, session re-check
│       └── index.ts              # NEW  openNotificationStream(request): Response — admission and framing
├── app/api/me/notifications/
│   ├── route.ts                  # unchanged (the fallback's route, and the client's 401 probe)
│   ├── recent/route.ts           # unchanged (the panel's rows)
│   └── stream/route.ts           # NEW  GET only, dynamic = "force-dynamic", delegates to the service
└── components/notifications/
    ├── poll.ts                   # UNCHANGED — the fallback, with its existing tests (FR-019)
    ├── refresh.ts                # NEW  pure supervisor: 5 states, fallback memory, backoff, yield, announce
    ├── refresh.test.ts           # NEW  every transition, with an injected EventSource and clock
    ├── NotificationBellClient.tsx# startRefreshing instead of startPolling; panel refreshKey; local-change marks
    └── NotificationPanel.tsx     # + refreshKey prop in the existing fetch effect's dependencies (S29)

drizzle/
└── 0023_*.sql                    # NEW  one additive partial index on activity_events (+ meta/)

tests/
├── helpers/
│   ├── auth.ts                   # + a real `session` row, so the re-check has something to read
│   └── stream.ts                 # NEW  read a Response's SSE frames; a fake EventSource for the client tests
├── integration/notifications/
│   ├── stream-authz.test.ts      # NEW  no session, expired, API key, crafted input, two people, muted/off
│   ├── stream-payload.test.ts    # NEW  the body shape, no leak, headers, Content-Encoding, no shared response
│   ├── stream-delivery.test.ts   # NEW  cross-process writer, snooze expiry, a read in another tab, no event
│   ├── stream-reconnect.test.ts  # NEW  drop with writes while down, duplicate snapshot, clean close, no cursor
│   ├── stream-caps.test.ts       # NEW  process cap refuses, sixth displaces oldest, probe work flat at 50
│   ├── stream-teardown.test.ts   # NEW  sign-out, expiry, second sign-in, removal, rollback, no session extension
│   ├── stream-scope.test.ts      # NEW  harness: the two named reasons and nothing unpinned
│   ├── stream-view-mark.test.ts  # NEW  a stream request is not a problems view (N82)
│   └── stream-migration.test.ts  # NEW  0023 on a seeded install, on its own database
├── unit (co-located)             #     stream-protocol.test.ts, registry.test.ts, watcher.test.ts, refresh.test.ts
└── integration/docs/             # + the deployment and activity assertions these docs owe

docs/
├── decisions.md        # N68-N84 next to N12/N39/R10/R11/R12/R15; the N12 reversal in place; S1-S32
├── deployment.md       # §7: buffering, the timeout, the ceiling, HTTP/1.1 per-origin, the fallback promise
└── activity.md         # line 78: push within seconds, automatic fallback, no setting
```

**Structure Decision**: the existing single Next.js app, with every piece put where the same concern
already lives. The wire protocol goes in `src/lib/notifications/` beside `eligibility.ts` and `types.ts`
because it is pure and both sides import it — that shared import is what makes the client's deadline and
the server's heartbeat one fact rather than two. The server runtime goes in
`src/server/services/notifications/stream/` beside the `panel.ts` and `view-mark.ts` that already serve
the bell, split so each file is testable on its own: the registry is pure over an injected clock, the
watcher is pure over an injected probe and recompute, and only `connection.ts` and `index.ts` touch a
`Response`. The two new readers go in `src/server/dal/` as their own small modules, the way `health.ts`
and `install.ts` already hold install-wide reads. The route sits under `/api/me/notifications/` with its
two siblings. The client supervisor sits beside `poll.ts` with the same injected-environment shape and
the same no-DOM test style, which is what lets `poll.ts` be left exactly as it is.

## Phase 0 — Research

[research.md](./research.md): **no marked gaps** — no `NEEDS RESEARCH`, no `NEEDS DEPENDENCY`, no
`NEEDS CLARIFICATION` — a table of every external fact with the installed file and line it came from, and
thirty-two plan decisions `S1`–`S32`. The ones worth reading before implementation starts:

- **S2** — why the stream must declare `Content-Encoding: identity`, verified from the bundled
  `compression` middleware that `next start` installs on every request and whose `compressible` table has
  no `text/event-stream` entry. Without it the framework itself is the buffering proxy N77 is about.
- **S14 and S15** — the nine fingerprint scalars with the reason each is there, what is deliberately
  absent, and why scalar #1 needs migration `0023` to be both O(1) and attention-only. This is the
  correctness argument for FR-008 and FR-010 and the cost argument for SC-004.
- **S16** — the one-line pre-existing inconsistency the fingerprint turns into a bug, and the fix.
- **S7 and S12** — the two places `EventSource` cannot tell the client *why*, and how a one-event
  `unavailable` response and one request to the existing count route answer FR-014 and FR-021 without
  reading a status code.
- **S20** — why the session re-check is a read-only `SELECT` and not `auth.api.getSession`, with the
  Better Auth behaviour that makes it sound.
- **S19** — the two framework behaviours the design refuses to assume, and what guarantees teardown
  instead.
- **S17 and S18** — the silence watchdog the spec implies but does not name, and why the lifetime is
  4.5 minutes rather than 5.

## Phase 1 — Design

- [data-model.md](./data-model.md): the one index and its migration; the fingerprint's exact statement and
  the change-detection table; the three in-memory entities (snapshot, connection, watcher) with every
  field and its lifetime; the fourteen invariants; the recompute statements, named and unchanged; and the
  entity map against the spec's Key Entities.
- [contracts/stream.md](./contracts/stream.md): the endpoint, its response headers and the ones
  deliberately absent, the five events with their exact frames, the refusal cases with their status codes
  and bodies, what is never on the wire, and the deliberate absence of any public-API operation, webhook
  event or new environment variable.
- [contracts/server.md](./contracts/server.md): the registry, watcher and connection signatures; the
  admission order; the caps and displacement; the heartbeat, lifetime and session-re-check timers; the two
  DAL readers; the bounded-concurrency rule; and what every failure does.
- [contracts/client.md](./contracts/client.md): the five states and every transition with its trigger and
  timer, the injected environment, the per-tab fallback memory, the announcement baseline, the 2-second
  yield, the bell and panel edits, and the accessibility rules that stay exactly as they are.
- [quickstart.md](./quickstart.md): how to run it with and without a proxy that buffers, the check that
  proves each of the six user stories, the capacity and probe-cost measurements, and the by-hand
  walk-through that goes last.

**Post-design Constitution re-check**: still passing, with nothing new to justify. The design adds one
route handler, one shared pure module, four server modules, two small DAL readers, one client module and
one additive index; it changes one line of existing DAL code, two client components and three documents.
It adds no table, no column, no environment variable, no dependency, no infrastructure, no screen and no
control. Isolation is unchanged — the one sanctioned project-set reader does every per-person read and the
one named escape hatch does the single install-wide statement. One service function answers "what is the
count" for the stream, the route and the page alike. No secret, address, name, message or event id reaches
the wire, a log or a snapshot. Nothing in the stack grows, and nothing a person can see changes except how
quickly the number does.

## Complexity Tracking

No constitution violation to justify. The one new index is a performance decision argued in S15 and
authorised by the spec's own assumption; the two undocumented framework behaviours are named in S19 and
deliberately not relied on, which is what constitution I asks of a phase that cannot reach the web.
