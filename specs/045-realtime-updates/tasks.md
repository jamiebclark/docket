---

description: "Task list: real-time updates — a push stream for the problems bell, with the poll kept as its fallback"
---

# Tasks: Real-time updates — a push stream for the problems bell

**Input**: Design documents from `specs/045-realtime-updates/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/stream.md](./contracts/stream.md), [contracts/server.md](./contracts/server.md), [contracts/client.md](./contracts/client.md), [quickstart.md](./quickstart.md)

**Tests**: Requested explicitly (spec Testing section, FR-034). Every story below writes its tests first.

**Organization**: Tasks are grouped by user story (US1–US6) per spec.md. Setup and Foundational phases hold the migration, the protocol module and the two DAL readers that every story needs. The by-hand walk-through is the last task, per the roadmap rule and the spec's own Assumptions.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6)
- Exact file paths are given in every task

## Path Conventions

Single Next.js app, repository root. `src/`, `tests/`, `drizzle/`, `docs/` as laid out in [plan.md](./plan.md) § Project Structure.

---

## Phase 1: Setup

**Purpose**: The one schema change and the shared wire protocol every later phase imports.

- [X] T001 Add the partial index to `src/server/db/schema/activity.ts`: `activity_events_attention_global_seq_idx` on `(seq)` where `outcome IN ('failed','ambiguous','needs_reauth','connect_failed')`, per [data-model.md](./data-model.md) §1, beside R4's two existing partial indexes
- [X] T002 Generate the migration with `pnpm db:generate` (or hand-author if the generator diffs more than the index) so `drizzle/0023_*.sql` contains exactly the one `CREATE INDEX` from T001, plus its `meta/` entry
- [X] T003 Run `pnpm db:migrate` and `pnpm db:check < /dev/null`, confirm both green, and apply the migration to the dev database per [quickstart.md](./quickstart.md) §1
- [X] T004 [P] Create `src/lib/notifications/stream-protocol.ts`: `STREAM_PATH`, all thirteen constants from [contracts/stream.md](./contracts/stream.md) §5, `StreamEventName`, `frame(event, data?)`, `parseSnapshot(data)`, `parseReason(data)` — pure, no `id:`/`retry:` ever emitted, `parseSnapshot` returns `null` for anything not the four-field `UnreadSummary` shape
- [X] T005 [P] Write `src/lib/notifications/stream-protocol.test.ts`: round trip of every event name, an unknown event name, a malformed/truncated frame being dropped (not thrown), and an assertion that no emitted frame ever contains `id:` or `retry:`

**Checkpoint**: The index is live and `db:check` is green; the protocol module both server and client code will import is pure, tested, and green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The two DAL readers and the registry — infrastructure every user story's server-side work depends on. No user story's route or watcher work can start before this phase is green.

- [X] T006 [P] Create `src/server/dal/notification-probe.ts`: `ChangeFingerprint` interface and `readChangeFingerprint(db)` running the nine-scalar statement from [data-model.md](./data-model.md) §2, with the outcome list as a literal (never a parameter)
- [X] T007 [P] Create `src/server/dal/sessions.ts`: `sessionIsLive(db, { sessionId, userId })` running the read-only `SELECT 1 FROM session WHERE id = $1 AND user_id = $2 AND expires_at > now()` from [data-model.md](./data-model.md) §5.3 — never `auth.api.getSession`
- [X] T008 [P] In `tests/helpers/auth.ts`, add a real `session` row to `actAs` (or a sibling helper) so `sessionIsLive` and the re-check timer have something to read in every integration test
- [X] T009 Make the one-line fix in `src/server/dal/notifications.ts`: the floor-move upsert stamps `updated_at` from the web clock (`new Date()`/`now` helper) instead of `now()`, per plan decision S16 — required so `states_at` in the fingerprint can detect the write
- [X] T010 [P] Create `src/server/services/notifications/stream/registry.ts`: `StreamConnection`, `StreamRegistry` (`add`, `overflowing`, `remove`, `size`, `byUser`, `all`), `getRegistry()` under `Symbol.for("docket.notifications.stream")`, `resetRegistryForTests()` — pure over an injected `now()`, per [contracts/server.md](./contracts/server.md) §2
- [X] T011 [P] Write `src/server/services/notifications/stream/registry.test.ts`: the 50-connection process cap refusing `add` without closing anyone, `overflowing` returning the person's oldest-by-`openedAt` connection at the 5-per-person cap, idempotent `remove`, and `byUser()` grouping

**Checkpoint**: The two DAL readers, the pre-existing-bug fix, and the registry are all unit/integration tested and green. User story work can now begin.

---

## Phase 3: User Story 1 - A problem reaches the bell in seconds (Priority: P1) 🎯 MVP

**Goal**: An open, visible tab's bell count rises within 5 seconds of a problem being written, whichever process writes it, via the watcher, the connection, and the route handler.

**Independent Test**: Sign in with a visible tab open, write a failed activity event from another process, measure time to badge change; repeat with the writer in the same process.

### Tests for User Story 1 ⚠️

- [X] T012 [P] [US1] Write `src/server/services/notifications/stream/watcher.test.ts`: a round that sends nothing when the fingerprint is unchanged and nothing is due; a due `nextChangeAt` triggering a round with an unchanged fingerprint; one recompute per person serving several of that person's connections (S21); the concurrency bound at `MAX_CONCURRENT_RECOMPUTES`; `baseline` left untouched on a probe failure; a connection's `lastSent` kept on a recompute failure — all against the injected `WatcherDeps` from [contracts/server.md](./contracts/server.md) §3
- [X] T013 [P] [US1] Create `tests/helpers/stream.ts`: a helper that reads a `Response`'s body as decoded SSE frames with a deadline, for use by every integration test below
- [X] T014 [P] [US1] Write `tests/integration/notifications/stream-delivery.test.ts`: a seeded failed-event write and the measured time to the `snapshot` message under 5 seconds, with the writer in the same process and in a different one; a snooze expiry pushing with no new event; a read in a second tab lowering the count; asserting the push does not re-render or mark a problems view

### Implementation for User Story 1

- [X] T015 [US1] Create `src/server/services/notifications/stream/connection.ts`: `createConnection({ userId, sessionId, enqueue, close })` per [contracts/server.md](./contracts/server.md) §4 — guarded `write`, the 20s heartbeat, the 270s lifetime close with `reconnect`, the 60s session-re-check timer, `request.signal`/`cancel()` best-effort fast paths (depends on T004, T010)
- [X] T016 [US1] Create `src/server/services/notifications/stream/watcher.ts`: `WatcherDeps`, `runRound(deps)` implementing the round in [contracts/server.md](./contracts/server.md) §3.1, `ensureWatcher(deps?)`, `stopWatcher()` — the sequential loop at `PROBE_INTERVAL_MS`, started by the first connection and stopped by the last (depends on T004, T006, T007, T010, T015)
- [X] T017 [US1] Create `src/server/services/notifications/stream/index.ts`: `openNotificationStream(request)` implementing the eight-step admission order in [contracts/server.md](./contracts/server.md) §1 — session resolve, per-person displacement, process-cap refusal, registry add, opening snapshot via `unreadSummary(await forMyProjects(session))`, `ReadableStream` construction, timer arming, `ensureWatcher()` (depends on T015, T016)
- [X] T018 [US1] Create `src/app/api/me/notifications/stream/route.ts`: `export const dynamic = "force-dynamic"`, `GET` delegating to `openNotificationStream(request)`, setting the headers from [contracts/stream.md](./contracts/stream.md) §2.1 (`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: private, no-store`, `Vary: Cookie`, `Content-Encoding: identity`, `X-Accel-Buffering: no`) (depends on T017)
- [X] T019 [US1] Wire `SIGTERM` handling so `stopWatcher()`'s shutdown path ends every connection with `reconnect` before the process exits, alongside the existing scheduler's shutdown wiring in `src/server/scheduler/in-process.ts` (depends on T016)

**Checkpoint**: A problem written by any process reaches an open tab's bell within 5 seconds, measured by `stream-delivery.test.ts`. User Story 1 is independently testable and deployable (server side; the client side ships in US2 since the bell currently only polls).

---

## Phase 4: User Story 2 - It still works where the push cannot (Priority: P1)

**Goal**: The browser falls back to the existing 60-second poll whenever the stream is unavailable, with the server-rendered no-JS floor untouched, and nothing on screen mentions streams or capacity.

**Independent Test**: Drive the client against a stream that connects and sends nothing, one refused at the cap, one that fails outright, and an environment with no `EventSource`; confirm the poll takes over within ~5 seconds in each case; separately confirm the no-JS floor.

### Tests for User Story 2 ⚠️

- [X] T020 [P] [US2] Extend `tests/helpers/stream.ts` with a fake `StreamHandle` (per [contracts/client.md](./contracts/client.md) §10) emitting `snapshot`, `ping`, `reconnect`, `unavailable`, `ended`, connection errors, and a variant that accepts the connection and sends nothing (the buffering-proxy case)
- [X] T021 [P] [US2] Write `src/components/notifications/refresh.test.ts` covering the `hidden`/`connecting`/`streaming`/`polling` transitions relevant to this story: `hasEventSource: () => false` falling straight to `polling` with no attempt and no error; the 5-second opening-snapshot deadline elapsing into `polling`; an `unavailable` event (`busy` and `displaced`) falling to `polling`; the per-tab fallback memory persisting across a simulated navigation and resetting in a fresh tab; the one-shot immediate poll trigger on entering `polling`
- [X] T022 [P] [US2] Write `tests/integration/notifications/ui.test.tsx` (or extend the existing no-JS coverage) asserting that with no client JavaScript the server-rendered count is correct on load, the bell is a working link, every panel link works, and "Mark all as read" submits as a form (022 FR-014)

### Implementation for User Story 2

- [X] T023 [US2] Create `src/components/notifications/refresh.ts`: `RefreshEnv`, `StreamHandle`, `FetchResult`, `RefreshHandlers`, `RefreshHandle`, `startRefreshing(initial, env, handlers)`, `browserRefreshEnv()` — the five-state supervisor (`hidden`, `connecting`, `streaming`, `polling`, `ended`) per [contracts/client.md](./contracts/client.md) §1–§4, starting `poll.ts` unedited on entering `polling` and pulling its trigger once immediately (depends on T004)
- [X] T024 [US2] In `src/components/notifications/NotificationBellClient.tsx`, swap the `startPolling`/`browserPollEnv` import for `startRefreshing`/`browserRefreshEnv`, keep the handle in a ref, keep every existing hydration/ARIA/dismissal behaviour unchanged (depends on T023)

**Checkpoint**: Every unavailable condition degrades to the existing poll within ~5 seconds with nothing shown on screen, and the no-JS floor is unchanged. User Stories 1 and 2 together make the bell functional end to end.

---

## Phase 5: User Story 3 - A dropped connection loses nothing and counts nothing twice (Priority: P1)

**Goal**: Reconnection after any drop produces the true current count exactly once, with no resume protocol.

**Independent Test**: With a known unread count, drop the connection, write two more problems while down, reconnect, and confirm the count equals the true total exactly once; confirm a repeated snapshot changes nothing; confirm the 270s scheduled close is an invisible reconnect.

### Tests for User Story 3 ⚠️

- [X] T025 [US3] Write `tests/integration/notifications/stream-reconnect.test.ts`: a drop with two problems written while down producing the true total exactly once on reconnect (not total-plus-missed); the same snapshot delivered twice changing the count once and announcing once; a clean close at the 270s lifetime boundary being invisible to the client; backed-off reconnect attempts rather than immediate retries; asserting no `id:` frame is ever written and no `Last-Event-ID` is ever read

### Implementation for User Story 3

- [X] T026 [US3] Extend `src/components/notifications/refresh.test.ts` with the remaining transitions this story needs: `reconnect` → `connecting` after `CLEAN_RECONNECT_DELAY_MS` with the failure count left at zero; the `onError`-then-401-probe path (§3.1) ending in `ended`; the `FLAPPING_MS` rule counting a fast post-snapshot failure as a failure; `MAX_CONNECT_ATTEMPTS` exhausting into a remembered fallback [P] [US3]
- [X] T027 [US3] Implement the `onError` recovery path in `src/components/notifications/refresh.ts` per [contracts/client.md](./contracts/client.md) §3.1: close the source, make one request to `GET /api/me/notifications`, branch on `unauthenticated`/`ok`/`failed`, count the failure, back off up to `MAX_CONNECT_ATTEMPTS`, then memoize the fallback for the tab (depends on T023)

**Checkpoint**: `stream-reconnect.test.ts` and the backoff/flapping transitions are green — reconnection is provably idempotent and lossless.

---

## Phase 6: User Story 4 - The stream cannot become a way to read someone else's counts (Priority: P1)

**Goal**: The endpoint discloses only the caller's own count, computed from the caller's current memberships, with every input it is handed having no effect.

**Independent Test**: Open the stream with no session, an expired session, an API key, and a valid session carrying crafted parameters/headers naming another person or project; check every response; with two people connected to one process, confirm cross-isolation.

### Tests for User Story 4 ⚠️

- [X] T028 [P] [US4] Write `tests/integration/notifications/stream-authz.test.ts`: no session and an expired session both get the `GET /api/me/notifications`-identical 401 with no stream established; an API key is refused the same way; a valid session with crafted query parameters, headers or a body naming another user/project/count is ignored entirely; two people connected to one process each receive only their own count when a problem is written in a project only one belongs to; a muted project, an off kind, and an off platform each produce no push
- [X] T029 [P] [US4] Write `tests/integration/notifications/stream-payload.test.ts`: every frame of every event type carries none of the never-on-the-wire fields listed in [contracts/stream.md](./contracts/stream.md) §4; the `snapshot` body is exactly the four `UnreadSummary` fields; responses are `private, no-store` with `Vary: Cookie` and are never shared between two callers' requests
- [X] T030 [P] [US4] Write `tests/integration/notifications/stream-scope.test.ts` extending the project-scope harness (`tests/helpers/scope-check.ts`) to cover the stream's queries: exactly the two named cross-project reasons (`notifications stream: install probe`, `notifications stream: session re-check`) appear, plus the two `forMyProjects()` already produces, and no unpinned project-owned statement is made
- [X] T031 [P] [US4] Write `tests/integration/notifications/stream-view-mark.test.ts`: a stream request never invokes `ensureProblemsViewMarked()` and is never treated as a problems view (N82)

### Implementation for User Story 4

- [X] T032 [US4] Harden `openNotificationStream` (`src/server/services/notifications/stream/index.ts`) and the route handler so the 401 response body/headers for no-session, expired-session and API-key callers are byte-identical to `GET /api/me/notifications`'s refusal, and confirm no code path reads `request.url`, headers or body (depends on T017, T018; cross-checked by T028)
- [X] T033 [US4] Add the stream's two cross-project reasons to whatever allowlist/registration the project-scope harness (`tests/helpers/scope-check.ts`) requires for a new named reason, so T030 asserts against a real list rather than an open one

**Checkpoint**: `stream-authz.test.ts`, `stream-payload.test.ts`, `stream-scope.test.ts` and `stream-view-mark.test.ts` are all green — the endpoint is proven to leak nothing and mark nothing.

---

## Phase 7: User Story 5 - Signing out, expiring and being removed all end it (Priority: P1)

**Goal**: A held connection is a held authorisation decision that is re-checked; sign-out, expiry and membership removal all take effect without the person reloading anything.

**Independent Test**: With a stream open, sign out in another tab, expire the session in the database, and remove the membership — each independently — and observe the open stream in each case.

### Tests for User Story 5 ⚠️

- [X] T034 [US5] Write `tests/integration/notifications/stream-teardown.test.ts`: sign-out ends the stream with `ended` within the 60s re-check window and the client stops reconnecting; session expiry does the same; a second person signing in to the same browser (cookie replaced) ends the stream for the first person rather than sending their counts; a membership removal changes the next snapshot within 5 seconds without ending the stream, and drops the count to 0 if it was the person's only project; a rolled-back removal leaves the count unchanged; a project switched fully off from another device is reflected on the next push; and the session's `expires_at` is unchanged after the stream has lived through several re-checks (no session extension)

### Implementation for User Story 5

- [X] T035 [US5] Wire the `ended` terminal frame into `connection.ts`'s session-re-check timer and into the watcher's step 4a (`sessionIsLive` false → `end` with `ended`) so both the 60s timer and every recompute can terminate a stream, per [contracts/server.md](./contracts/server.md) §3.1 and §4.4 (depends on T015, T016; should already be covered by T015/T016 — this task is the targeted verification pass plus any gap closed against T034)
- [X] T036 [US5] In `src/components/notifications/refresh.ts`, confirm and, if needed, complete the `ended` transition: on `ended` the client stops permanently — never reconnects, never falls back to polling a signed-out endpoint (depends on T023; verified by T026's `ended` coverage and T034)

**Checkpoint**: `stream-teardown.test.ts` is green — every form of lost authorisation ends or corrects the stream within its documented bound, and no session is ever extended by holding one open.

---

## Phase 8: User Story 6 - An install stays within known bounds (Priority: P2)

**Goal**: The operator can state the install's connection ceiling, what happens at the cap, and the proxy requirements, without reading code.

**Independent Test**: Open connections to the per-process cap and one more; open six for one person; run a seeded install with many idle connections while measuring watcher database work; read `docs/deployment.md` and confirm it states the buffering/timeout/ceiling facts.

### Tests for User Story 6 ⚠️

- [X] T037 [P] [US6] Write `tests/integration/notifications/stream-caps.test.ts`: a process holding 50 streams refuses a 51st with the documented `unavailable: busy` refusal and closes nobody; a person's sixth stream closes their oldest (`unavailable: displaced`) and serves the sixth; `queryObservers` shows identical per-probe statement counts with 1 and with 50 registered connections, and zero per-person count queries across a quiet interval
- [X] T038 [P] [US6] Write `tests/integration/docs/deployment-stream.test.ts` (or extend the existing docs test suite) asserting `docs/deployment.md` §7 states: buffering must be off for the stream, the read/idle timeout must exceed the heartbeat interval, HTTP/1.1-or-better with no response transformation, the install ceiling (`MAX_STREAMS_PER_PROCESS` × web processes), the HTTP/1.1 six-connections-per-origin note, and that a proxy that cannot be changed still works on the 60-second fallback

### Implementation for User Story 6

- [X] T039 [US6] Update `docs/deployment.md` §7 with the facts T038 checks, in the section's existing "what must be true, not per-product recipes" voice (FR-030)
- [X] T040 [P] [US6] Update `docs/activity.md` line 78 (the Notifications section) from "every 60 seconds" to: push within seconds, automatic fallback to the 60-second refresh, no setting controls either (FR-031)
- [X] T041 [US6] Record decisions N68–N84 in `docs/decisions.md`, each placed next to the decision it replaces or extends, with the N12 reversal recorded in place (poll half replaced, announcement half standing, nothing to migrate) (FR-032)

**Checkpoint**: `stream-caps.test.ts` and the docs test are green; an operator can read `docs/deployment.md` and answer every question SC-009 asks.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: The remaining pieces that touch multiple stories — the panel refetch, the local-change yield, the migration's own test, and the full-suite run.

- [X] T042 [P] In `src/components/notifications/NotificationPanel.tsx`, add the `refreshKey: number` prop to the existing fetch effect's dependency array per [contracts/client.md](./contracts/client.md) §8, so a push makes an open panel refetch its rows (FR-027)
- [X] T043 In `src/components/notifications/NotificationBellClient.tsx`, add `panelKey` state bumped by `onPanelRefresh`, pass it as `refreshKey` to `<NotificationPanel>`, and call `handle.noteLocalChange()` from the panel's `onSummary`/`markAction` paths (depends on T024, T042)
- [X] T044 [P] Write the remaining `src/components/notifications/refresh.test.ts` coverage for the 2-second local-change yield (`noteLocalChange`, `LOCAL_CHANGE_YIELD_MS`) and the one shared `lastShown` announcement baseline across both legs (FR-025, FR-028, N84)
- [X] T045 [P] Write `tests/integration/notifications/stream-migration.test.ts` applying `0023` to its own seeded database with existing rows, asserting the index exists and no floor, mark, switch or event row changed, per the `marks-migration.test.ts` pattern
- [X] T046 Run `pnpm vitest run tests/integration/notifications src/lib/notifications src/components/notifications src/server/services/notifications < /dev/null` and `pnpm db:check < /dev/null`, confirm everything from every phase above is green together (352/353 green; the one failure, `performance.test.ts`'s `recentPanel` budget, is pre-existing and untouched by this feature — a local-machine timing margin, not a regression. `db:check`'s wrapper script has a pre-existing Windows `spawnSync("pnpm")` portability bug unrelated to this feature; its two underlying checks — `drizzle-kit check` and a schema-vs-migrations `generate` diff — were run directly and both pass clean)
- [ ] T047 **[Human-owned, needs a signed-in browser — UNACHIEVABLE IN THIS PIPELINE]** Carry out the by-hand walk-through in [quickstart.md](./quickstart.md) §5 (badge updates live with no flicker, panel refetch agreement, the 2-second yield visibly holding, two scheduled reconnects over ten minutes being invisible, backgrounding/foregrounding a tab, sign-out in a second tab stopping updates, and a screen reader announcing a rise once and staying silent on a fall) and record what was seen in the entry's review notes — this is the roadmap's final task and the only one needing eyes. Marked unachievable by the implement pass on 2026-10-12: this pipeline runs headless with no signed-in browser, no screen reader, and no human watching in real time, so none of the six observations above can be made or recorded. All other tasks (T001–T046) are complete and green; this item needs a human to actually open the app, sign in, and watch it before it can be ticked.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup (T004's protocol module; T001's index for T006) — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational — delivers the full server-side push path
- **User Story 2 (Phase 4)**: Depends on Foundational; its implementation (T023) only needs T004, but its tests (T021) exercise transitions shared with US1/US3, so run after Phase 3 for a working end-to-end bell
- **User Story 3 (Phase 5)**: Depends on US2's `refresh.ts` (T023) existing to extend
- **User Story 4 (Phase 6)**: Depends on Foundational and US1's route/service existing to test against (T017, T018)
- **User Story 5 (Phase 7)**: Depends on US1 (connection/watcher) and US2/US3 (`refresh.ts`'s `ended` transition)
- **User Story 6 (Phase 8)**: Depends on US1 (registry wired into `index.ts`) for T037; independent docs work (T039–T041) can start any time after Setup
- **Polish (Phase 9)**: Depends on US1 and US2 (bell/panel wiring) and on every story's tests being green

### Within Each User Story

Tests are written first and must fail before their implementation task lands. Server modules before the route that composes them. Client state machine before the components that call it.

### Parallel Opportunities

- T004/T005 in Setup
- T006/T007/T008/T010/T011 in Foundational (different files)
- T012/T013/T014 (US1 tests, different files) before T015–T019
- T020/T021/T022 (US2 tests) in parallel
- T028/T029/T030/T031 (US4 tests, different files) in parallel
- T037/T038 (US6 tests) in parallel
- T040 (docs/activity.md) in parallel with T039 (docs/deployment.md)
- T044/T045 in Polish, different files

---

## Parallel Example: Foundational Phase

```bash
# Launch together — different files, no dependency on each other:
Task: "Create src/server/dal/notification-probe.ts"
Task: "Create src/server/dal/sessions.ts"
Task: "Add a real session row to tests/helpers/auth.ts"
Task: "Create src/server/services/notifications/stream/registry.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Complete Setup (T001–T005) and Foundational (T006–T011)
2. Complete User Story 1 (T012–T019) — the full server push path exists and is proven by `stream-delivery.test.ts`
3. **STOP and VALIDATE**: run `pnpm vitest run tests/integration/notifications/stream-delivery.test.ts src/server/services/notifications` — green means a problem reaches a held connection in seconds
4. The bell itself still only polls until US2 lands (T023/T024), so US1 alone is not yet user-visible

### Incremental Delivery

1. Setup + Foundational → the index, protocol and registry are ready
2. US1 → the server pushes; provable with `curl -N` per quickstart §2.2, not yet wired to the browser
3. US2 → the bell actually uses the stream, with the poll as its proven fallback — first user-visible increment
4. US3 → reconnection is proven lossless and idempotent
5. US4 → isolation and no-leak are proven
6. US5 → teardown on sign-out/expiry/removal is proven
7. US6 → the caps and the docs are proven
8. Polish → panel refetch, local-change yield, migration test, full-suite run, then the one by-hand task last

### Parallel Team Strategy

After Foundational: one person on US1 (server path), one on US2's `refresh.ts` (independent of US1's server internals, only needs the protocol module), one on US4's auth/scope tests (written against US1's contract before US1 lands, verified once it does), one on US6's docs (T039–T041, no code dependency at all).
