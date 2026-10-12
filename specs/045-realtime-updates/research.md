# Phase 0 — Research: real-time updates

**Feature**: `specs/045-realtime-updates/` · **Branch**: `061-realtime-updates` · **Date**: 2026-10-12

## 0. Marked gaps

**None.** No `NEEDS RESEARCH`, no `NEEDS DEPENDENCY`, no `NEEDS CLARIFICATION`.

The spec said so and this phase confirmed it by reading the installed packages rather than remembering
them:

| Fact the design needs | Where it was verified |
|---|---|
| A Route Handler may return a Web `ReadableStream`, and that is the framework's own way to do Server-Sent Events | `node_modules/next/dist/docs/01-app/02-guides/streaming.md:484-535` ("Streaming in Route Handlers", Next 16.3.8) |
| `EventSource` needs no package | Browser built-in; nothing is added to `package.json` |
| A same-origin `EventSource` is already allowed by the Content-Security-Policy | `src/lib/http/security-headers.ts:17, 28` — `connect-src 'self'` (plus the upload origin). `EventSource` is governed by `connect-src`, so no header moves |
| `next start` / the standalone server compresses responses, and how to opt one out | `node_modules/next/dist/server/lib/router-server.js:123-126, 257-265` and the bundled `compression`/`compressible` in `node_modules/next/dist/compiled/compression/index.js` — see S2 |
| Signing out deletes the `session` row; refreshing a session updates the same row | `node_modules/better-auth/dist/api/routes/sign-out.mjs` (deletes by token) and `node_modules/better-auth/dist/db/internal-adapter.mjs:410-414, 451-485` (1.7.7) — see S20 |
| Node's `requestTimeout` governs receiving a request, not writing a response; Next only sets `keepAliveTimeout` when asked | Node 24 docs for `http.Server`; `node_modules/next/dist/server/lib/start-server.js:248-249` — see S18 |
| All three roles hold `post: view`, so a role change cannot change who counts | `src/server/auth/access.ts:11, 28, 43` — see S14 |
| Every notification write stamps `updated_at`, and exactly one of them uses the web clock | `src/server/dal/notifications.ts:392, 435, 445, 482, 488` — see S16 |
| Activity events are written only for publish outcomes and connect attempts, and are never purged | `src/lib/activity/outcomes.ts:4-12`, `src/server/services/activity/record.ts`, `src/server/scheduler/housekeeping.ts` (no activity purge) — see S15 |

Nothing in this entry needs a credential, a socket to a third party or a browser to prove its logic, so
nothing is "verified with mocks only" either. The one by-hand walk-through is a visual check and goes last
in `tasks.md` (roadmap rule).

---

## 1. Plan decisions

Thirty-two decisions, `S1`–`S32`. They are design choices about this repository's own code; the product
judgement calls are the spec's **N68–N84**. All of these are recorded in `docs/decisions.md` next to the
decisions they extend (FR-032).

### The endpoint and its wire format

#### S1 — One Route Handler returning a `ReadableStream`, under the existing personal prefix

`GET /api/me/notifications/stream`, `src/app/api/me/notifications/stream/route.ts`, with
`export const dynamic = "force-dynamic"` exactly like its two siblings. The installed framework's own
guide gives a `ReadableStream` from a Route Handler as the way to do Server-Sent Events, so there is
nothing to invent and nothing to research. `/api/me/` is already a public prefix in the auth gate
(`src/lib/auth-gate.ts:6`), which is what makes a cookie-less request a 401 rather than a redirect to
`/login` (FR-001).

**Alternatives rejected.** Long-polling the count route (keeps one request per update and still needs a
proxy that will hold a response, with none of SSE's framing or reconnection); WebSockets (a second
protocol, a second upgrade path through the operator's proxy, and Next gives no server for it); a
`fetch` + manual `ReadableStream` reader on the client instead of `EventSource` (it would expose the
status code, which would make S12 unnecessary — but the spec's own assumption is `EventSource`, and
`EventSource` is what FR-020's first fallback trigger is written against).

#### S2 — `Content-Encoding: identity` is how the stream escapes Next's own gzip

Verified, not assumed. `next start` and the standalone server install `next/dist/compiled/compression`
for **every** request unless `next.config.ts` sets `compress: false`:

```js
// node_modules/next/dist/server/lib/router-server.js:123-126
let compress;
if ((config == null ? void 0 : config.compress) !== false) { compress = (0, _compression.default)(); }
```

and the bundled `compressible` has **no `text/event-stream` entry at all** (checked: the string does not
appear in `node_modules/next/dist/compiled/compression/index.js`), so it falls through to that module's
`/^text\/|\+(?:json|text|xml)$/i` fallback and reports the stream *compressible*. A gzip stream that
buffers is precisely the failure N77 exists to catch, so the stream must not be compressed at all.

The same bundle shows the deterministic opt-out, in its own `onResponseHeaders` listener:

```js
var c = o.getHeader("Content-Encoding") || "identity";
if (c !== "identity") { nocompress("already encoded"); return; }
```

so a response that declares `Content-Encoding: identity` is passed straight through and no zlib stream is
even created. (The same listener also skips a first chunk under the 1 KB threshold, which our opening
snapshot is — but that is an accident of payload size, not a contract, and a heartbeat-only connection
would be living on it. We state the header.)

**Alternatives rejected.** `compress: false` in `next.config.ts` (turns compression off for every page in
the app to fix one route); relying on the size threshold (fragile, as above); a custom server (forbidden
by the fixed stack).

#### S3 — `X-Accel-Buffering: no` as well, and the documented requirement as the real answer

nginx and its relatives read `X-Accel-Buffering` and turn buffering off for that one response; it costs a
header and nothing else. Every other proxy is covered by what `docs/deployment.md` §7 must say (FR-030,
N78), because no proxy product has been researched (constitution I) and the client falls back by itself
when the response is buffered anyway (N77).

#### S4 — The response headers, and the ones deliberately absent

`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: private, no-store`, `Vary: Cookie`,
`Content-Encoding: identity`, `X-Accel-Buffering: no`. The first three are the house convention the two
sibling routes already use, so a shared response is impossible (FR-004). No `Connection: keep-alive`
header: it is meaningless on HTTP/1.1 (the default) and illegal on HTTP/2. No `Content-Length`: a stream
has none, which is also what tells a proxy to use chunked transfer. `X-Content-Type-Options: nosniff` is
already set for `/:path*` by `next.config.ts`.

#### S5 — Five named events, no event ids, no `retry:` field

`snapshot`, `ping`, `reconnect`, `unavailable`, `ended` (contracts/stream.md §3). Named rather than the
default `message` event so every listener on the client is explicit and a message type added later can
never be mistaken for a count. **No `id:` field is ever sent**, which is what makes the browser omit
`Last-Event-ID` on reconnect: there is no cursor to honour and none to get wrong (N69, FR-005). **No
`retry:` field**, because the client drives its own reconnection (S11).

#### S6 — The heartbeat is a named `ping` event, not an SSE comment

The classic keep-alive is a comment line (`: ping`). A comment keeps the socket warm but dispatches
nothing to `EventSource`, so a client cannot observe it. A named `ping` event with an empty `data:` does
both jobs: it stops a proxy's idle timer firing (FR-016) **and** feeds the client's silence watchdog
(S17). It carries no count, updates nothing on screen and announces nothing.

### Caps, refusals and admission

#### S7 — The refusal at the process cap is a 200 stream carrying one `unavailable` event

Not a 503. `EventSource` surfaces neither the status code nor the body of a failed connect — `onerror`
gets an event with nothing useful on it — so a status-coded refusal is indistinguishable from a network
failure, and FR-014 requires a refusal "the client recognises as *fall back to polling*". A
`text/event-stream` response carrying exactly one `unavailable` event and then closing is recognisable
without inspecting anything, survives any proxy that passes the stream at all, holds no connection,
carries no count and is not an error page (N75). Nothing is queued and nobody else's stream is closed.

#### S8 — A displaced stream gets the same `unavailable`, and the displaced tab remembers it

N75 displaces a person's oldest stream when they open a sixth. The displaced tab must remember the
fallback for that tab — which FR-020 already requires for a cap refusal — because otherwise six tabs
displace each other round-robin for ever: tab 1 reconnects, displacing tab 2, which reconnects,
displacing tab 3. With the memory, the five newest tabs stream and the sixth polls, which is exactly what
N75 describes. This is a correctness argument, not tidiness.

#### S9 — Admission order: session, then the person's own displacement, then the process cap, then the count

1. `getSession()` → no session, expired session or API key: **401**, no stream (S10, FR-002).
2. If the person already holds `MAX_STREAMS_PER_PERSON` (5), close their oldest with `unavailable`.
3. If the process now holds `MAX_STREAMS_PER_PROCESS` (50), refuse with `unavailable` (S7).
4. Register the connection, then compute the opening summary and write it.

Displacing **before** the process check means a person at their own cap is never refused by a full
process for a slot they were about to free themselves. Computing the summary **last** means a refused
request costs no count query at all.

#### S10 — 401 is the count route's own refusal, byte for byte

`{"error":"unauthenticated"}` with `Cache-Control: private, no-store`, `Vary: Cookie` and
`Content-Type: application/json`, the same body and headers `GET /api/me/notifications` answers today
(`src/app/api/me/notifications/route.ts`). An API key is not a session, so `getSession()` returns null for
it and the same 401 applies with no extra code (US4 §2). No stream is established and no count is
disclosed.

### What the client does, and how it learns why

#### S11 — `EventSource`'s own reconnection is overridden entirely

On `onerror` the client calls `close()` on the source and lets its state machine decide what happens
next. `EventSource` reconnects on *every* error, with no way to learn whether the cause was a 401, a
refusal, a dropped socket or an ordinary server close — and a mechanism that cannot tell those apart
cannot honour FR-020's three-attempt limit, FR-014's "poll instead" or FR-021's "stop, do not poll".
The spec's assumption says the browser's reconnection is "used where it helps and overridden where this
entry needs its own rules"; in practice every rule this entry has needs the override, so the plan states
plainly that it is never relied on.

#### S12 — A 401 is learned from the existing count route, not from the stream

When a connect attempt fails before delivering its opening snapshot, the client makes **one** request to
`GET /api/me/notifications` — the route the poll already uses.

- **401** → FR-021's terminal verdict: stop, never reconnect, and do **not** start polling a signed-out
  endpoint.
- **200** → the session is live, so the failure was the stream's own: back off and retry (S25). The body
  is a fresh count, so the probe is also a refresh and the attempt costs the person nothing.

At most three such probes per tab. No new route, no new contract, no status-code reading, and it works
with `EventSource` exactly as the spec assumed.

**Alternative rejected.** `fetch`ing the stream endpoint itself to read its status: it would open a second
connection against the cap we are trying to measure, and would have to be aborted mid-headers.

#### S17 — A 45-second silence watchdog on the client

`EventSource` cannot see a socket that died without a FIN — a sleeping laptop, a phone changing network,
a proxy that starts buffering part-way through — the connection looks open and delivers nothing for ever.
So the client treats 45 seconds with no `snapshot` and no `ping` as a drop: close, and reconnect under the
ordinary rules. 45 s is just over two heartbeat intervals, so one lost `ping` is not a false alarm. It
counts as a drop, never as a terminal end.

The spec names the opening-snapshot deadline for a proxy that buffers *from the start* (N77) but nothing
for one that stops mid-stream. This is the piece that makes FR-015's "reconnect with no visible effect"
and US3's sleeping laptop actually true rather than hoped for; it is an addition the spec implies and does
not name, and it adds no requirement of its own.

#### S25 — One pure state machine, and `poll.ts` untouched

`src/components/notifications/refresh.ts`: `startRefreshing(initial, env, handlers)` over an injected
environment, with no DOM, exactly the shape `poll.ts` already has and testable the same way. Five states —
`hidden`, `connecting`, `streaming`, `polling`, `ended` — and the invariant FR-019 asks for falls out of
them: the stream is held in `connecting` and `streaming` and in neither of those does the poll run; the
poll runs in `polling` and no stream is held there. `poll.ts` is not edited at all: its interval, its
visibility rule, its in-page change event, its `nextChangeAt` one-shot, its silent failure handling, its
injected environment and its existing tests all stand (FR-019, N79).

Reconnection timing:

- a connection that delivered its opening snapshot and then closed is **not** a failure: reconnect after
  500 ms (invisible to a person, and a hard ceiling on how fast a tab can reconnect);
- a connection that never delivered its opening snapshot, or delivered it and died within 2 s, **is** a
  failure: attempt 2 after 1 s, attempt 3 after 2 s, each jittered, then the fallback is remembered for
  the tab (FR-020, US3 §4).

#### S26 — The fallback leg refreshes at once on entry, through `poll.ts`'s own hook

Entering the fallback must not wait up to 60 seconds for the poll's first tick. Rather than change
`poll.ts`, the supervisor hands `startPolling` a `PollEnv` whose `onChanged` subscribes to *both* the
existing `docket:notifications-changed` window event and its own internal trigger, and pulls that trigger
the moment it enters `polling`. That is `poll.ts`'s documented "refresh once on an in-page change" path
being used for what it is for — with no edit to the module FR-019 requires be left alone.

#### S27 — One announcement baseline across both legs

`poll.ts` keeps its own rise check, unchanged. The supervisor applies the same rule — announce only when
a snapshot is **higher** than what the page last displayed — to stream snapshots, and whenever it starts
the poll it starts it from the latest summary it holds. So switching legs can neither re-announce a count
the page already shows nor miss a rise across the switch (N70, FR-025, R15). An equal or lower snapshot
updates the badge silently, and a reconnect's identical opening snapshot announces nothing.

#### S28 — The 2-second yield is driven by the bell's own changes

Every locally-originated summary marks the moment: a row action's `onRowDone`, "Mark all as read", and
the in-page `docket:notifications-changed` event. Stream snapshots that arrive within
`LOCAL_CHANGE_YIELD_MS` (2 s) of that moment are dropped (N84, FR-028). The poll leg is **not** yielded
to: its own fetch always happens after the write that triggered it, so it cannot carry a stale value.

#### S29 — The panel refetches on a push through one new prop

`NotificationPanel` gains `refreshKey: number`, added to the dependency array of the fetch effect it
already has (`src/components/notifications/NotificationPanel.tsx:46-61`, which already re-runs on
`attempt`). The bell bumps it when a snapshot changes the count while the panel is open. Nothing else on
the page subscribes to a push, and `router.refresh()` is still never called (N83, FR-027, R10).

### How an event reaches every process

#### S13 — One watcher per web process, discovering change in the database they already share

No process notifies another (N71). Each web process runs one watcher — not one per connection — as a
single sequential loop: probe, then (if anything moved, or any connection's own due instant has passed)
one recompute round, then sleep to the next 2-second boundary. Because the loop is sequential, rounds can
never overlap, and because the probe is install-wide, the writer never has to find the holder: a problem
written by the worker container, by an external cron tick, by a tick running inside another web process,
or by the person themselves in another tab is seen by every process within one interval
(FR-008, FR-011, FR-012).

Nothing is added to the stack: no Redis, no queue, no process-to-process messaging, no sticky sessions,
and no Postgres `LISTEN`, which the constitution forbids outright because Neon's pooler is in transaction
mode.

**Alternative rejected.** A trigger-plus-`LISTEN` design would give sub-second delivery and is forbidden;
it is named here because it is the obvious thing to reach for, and because the spec's own assumption says
a future entry wanting sub-second delivery needs a different mechanism.

#### S14 — The fingerprint: nine scalars, one statement

One statement through the named cross-project escape hatch, compared for **equality** against the stored
baseline (never ordered, so nothing depends on any clock being monotone across machines):

| # | Scalar | Why it is there |
|---|---|---|
| 1 | `max(seq)` over attention-outcome events | A new problem. Additions only: the log is append-only and nothing purges it (`housekeeping.ts` has no activity purge), and a project deletion is caught by #9 |
| 2,3 | `count(*)`, `max(updated_at)` of `notification_states` | The read floor: a mark-all or a problems view moving `seen_seq` (update), a new membership's starting row (insert), a membership removal (delete) |
| 4,5 | `count(*)`, `max(updated_at)` of `notification_preferences` | A kind or platform switched on or off, and a switch row appearing or cascading away |
| 6,7 | `count(*)`, `max(updated_at)` of `notification_event_marks` | A per-event read or snooze written (insert), a snooze changed (update), a mark pruned by a floor move (delete) |
| 8,9 | `count(*)`, `max(created_at)` of `member` | A membership added or removed, including the whole-project cascade. `member` has no `updated_at` (`src/server/db/schema/auth.ts:95-114`) and needs none: **all three roles hold `post: view`** (`src/server/auth/access.ts:11, 28, 43`), so a role change cannot change who counts |

Why a count **and** an instant for each sparse table: `max(updated_at)` cannot see a deleted row, and
`count(*)` cannot see an in-place update. Together they see additions, changes and deletions, which is
what FR-010 demands. A delete and an insert inside one interval is caught by the instant (an insert takes
`DEFAULT now()`); an insert and a delete of different rows is caught by the instant too.

What is deliberately **not** in the fingerprint: `social_accounts` (the count does not read it — only the
preferences *grid* uses `platformsByProject`, and `countUnread` compiles eligibility from the preference
rows alone), `projects` (a rename cannot change a count; a deletion cascades to `member`), and the
`session` table (per-connection, S20).

**Over- and under-triggering.** Over-triggering is harmless by construction: a round that recomputes and
finds every snapshot unchanged sends nothing (FR-010). Under-triggering is the only real risk, and the
table above is the argument that there is none for any input the count reads.

#### S15 — One new partial index, migration `0023`, and why the probe needs it

```sql
CREATE INDEX activity_events_attention_global_seq_idx ON activity_events (seq)
  WHERE outcome IN ('failed', 'ambiguous', 'needs_reauth', 'connect_failed');
```

Scalar #1 has to be O(1) and attention-only. Without this index it can be one or the other but not both:

- `max(seq)` over the whole log is O(1) (the existing unique index `activity_events_seq_uq`) but moves on
  every **successful** publish, so a bulk publish of 100 targets would trigger 100 recompute rounds for
  every connected person — conformant but wasteful, and exactly the cost SC-004 promises not to pay;
- `max(seq)` restricted to the attention outcomes using R4's existing `(project_id, seq)` partial indexes
  has no leading-column restriction, so it is a full scan of those indexes — attention-only, but growing
  for ever with the number of problems the install has ever had.

With it, the scalar is a single-row index-only scan whose cost does not depend on the size of the install,
and only a real problem starts a round. The index is **partial**, so a successful publish pays only the
predicate evaluation, not an index entry.

It is pure additive DDL — one `CREATE INDEX`, no `UPDATE`, no `ALTER`, no data step — so it is safe on a
live install with existing rows, needs no operator action, and cannot touch a reading floor, a sparse mark
or a preference row (spec Assumptions). The one-time build takes a `SHARE` lock on `activity_events` for
the length of a scan of the attention rows; `docs/deployment.md` does not need to mention it, because
migrations already run before the web container serves (`MIGRATE_ON_START`). `pnpm db:check` must be green
and a migration test runs it against a seeded install.

#### S16 — `updated_at` is stamped by the database, not by the web process

`src/server/dal/notifications.ts` writes `updated_at = now()` in every raw statement (lines 435, 445,
482, 488) but **one** path builds it in JavaScript:

```ts
// src/server/dal/notifications.ts:392
const set: Record<string, unknown> = { updatedAt: new Date() };
```

That is harmless today, because nothing compares those instants. The fingerprint does. A web process whose
clock is behind the database's would stamp a floor move *into the past*, leaving `max(updated_at)`
unchanged and hiding the change until something else moved. Changing that one value to `sql\`now()\``
puts every notification write on one clock and makes scalars #3, #5 and #7 sound.

A pre-existing inconsistency, fixed in passing rather than reported and left. It changes no behaviour any
existing test asserts (nothing reads `notification_states.updated_at`), and it is inside the same
transaction as the `seen_at = now()` the same path already writes.

#### S20 — The session re-check is a read-only `SELECT`, never `auth.api.getSession`

FR-022 forbids the stream extending a session, and `getSession()` would: Better Auth refreshes a session
older than its update age (no `session` options are configured in `src/server/auth/auth.ts`, so the
package's defaults apply) and writes a new cookie — which a response whose headers are already sent cannot
deliver. A stream that renewed a session server-side would be keeping alive something the browser can no
longer prove it holds, which is the spec's own reason (FR-022, N81). `headers()` is also request-scoped,
so calling it from a watcher callback is not a thing the design should rest on.

So the connection keeps the session **id** it was opened with and the re-check is one read-only statement:
`SELECT 1 FROM session WHERE id = $1 AND user_id = $2 AND expires_at > now()`. Verified sound against the
installed package:

- sign-out **deletes** the row (`better-auth/dist/api/routes/sign-out.mjs` calls
  `internalAdapter.deleteSession(token)`, which is a `DELETE … WHERE token = …`,
  `internal-adapter.mjs:451-485`; no secondary storage and no `preserveSessionInDatabase` are configured);
- a refresh **updates the same row** rather than replacing it (`internal-adapter.mjs:410-414`, keyed on
  `token`), so the id is stable for the life of the session and a refresh never looks like a sign-out.

The user id is compared as well as the id, so a row that somehow belonged to someone else ends the stream
instead of serving it. The spec's "a second sign-in as a different person in the same browser" case
(Edge Cases) is covered twice over: signing in navigates, which unloads the page and so closes the
`EventSource`, and the connection can only ever serve the identity whose cookie opened it — a browser
cannot change the cookie on a response already in flight.

#### S21 — Two tabs of one person share one recompute

A round groups its connections by user id and computes each person's summary once, then compares it
against **each** connection's own last-sent value. So the per-person cap of 5 costs one count query rather
than five, and N72's "once per connected person per actual change" is literally what happens.

#### S22 — At most three recomputes at once, and a sequential loop

`DATABASE_POOL_MAX` defaults to 10 (`src/server/env.ts:305`) and one recompute holds one pooled
connection at a time, so a bound of 3 leaves 7 for ordinary page requests — FR-009's "cannot exhaust the
database pool or starve ordinary page requests". One recompute is about four indexed statements
(`forMyProjects`: the membership join and the preference read; `unreadSummary`: `countUnread` with its own
preference read, and `nextChangeAt`). A worst-case round at the cap is ≈50 people ÷ 3 concurrent × 4
statements ≈ 70 sequential round trips, comfortably inside the 2-second interval on a local or Neon
database. Because the loop is sequential, a slow round simply delays the next probe instead of piling up.

#### S23 — The watcher starts with the first connection and stops with the last

N72 says the fixed probe cost exists "whether anybody is connected or not". That is a statement about
cost, not a requirement, and stopping when idle only ever lowers it: a worker container and a quiet web
process do no probing at all, while SC-004's measured case — 10 open tabs, a quiet hour — is unchanged at
1,800 probes an hour. It also means a `pnpm build`, a migration run or a tick-only process never opens a
pool connection for this feature.

The singleton is guarded by `Symbol.for("docket.notifications.stream")` on `globalThis`, the pattern
`src/server/scheduler/in-process.ts:5-7` already uses so a hot reload or a second module evaluation
cannot produce two watchers. `SIGTERM` closes every connection with `reconnect` and stops the loop, which
is what makes a deploy look like an ordinary reconnect (US3 §5).

#### S24 — A failed probe changes nothing; a failed recompute keeps its connection

The stored baseline fingerprint is replaced **only** by a successful probe. So a database blip delays a
push by one interval rather than hiding the change for ever: the next good probe still differs from the
baseline. A recompute that throws leaves that connection's last-sent value alone and retries next round;
it never sends a wrong count, never closes the connection and never drops the person to polling. Neither
failure is shown to anybody, and both are logged at most once a minute so a sustained outage cannot fill
the log at 30 lines a minute (spec Edge Cases).

### Lifetime and teardown

#### S18 — The connection lifetime is 4.5 minutes, not 5

FR-015 says "at most 5 minutes". 270 s is chosen so that Docket is always the party that closes first:
300 seconds is the common default read timeout for reverse proxies and is also Node's documented
`requestTimeout` value. A lifetime set *at* the boundary races a timeout, and a timeout looks like a drop
(a failure to count, a backoff) rather than the scheduled close it is. 270 s has margin and is still
invisible: the reconnect's opening snapshot arrives in well under a second (N76).

Node's `requestTimeout` governs *receiving a request*, not writing a response, and `server.timeout` has
been 0 (disabled) since Node 13, so Node itself will not kill the stream; Next only sets
`keepAliveTimeout` when the flag is given (`start-server.js:248-249`), and that governs idle keep-alive
*between* requests. The margin is for the operator's proxy, which is the thing Docket does not control.

#### S19 — Teardown does not depend on `request.signal` or `cancel()`

Neither abort-on-client-disconnect nor `ReadableStream` cancellation on a dropped socket is documented
anywhere in the installed Next docs, so per constitution I the design asserts neither. Instead:

- **every** write to the stream is inside a `try`/`catch`; a write to a client that has gone throws, and
  that is what deregisters the connection and clears its timers;
- the 20-second heartbeat is therefore also the liveness check, so a vanished client is reaped within one
  heartbeat and absolutely within one lifetime (S18);
- `request.signal`'s `abort` and the stream's `cancel()` are still wired as best-effort fast paths,
  because when they do fire they free the slot immediately — but nothing in the design is unsound if they
  never fire.

This is what keeps the connection cap honest: a slot cannot be held by a client that no longer exists for
longer than 20 seconds.

#### S31 — A stream request cannot be mistaken for a problems view

Two independent reasons, and a test for each (N82, FR-026):

- the stream route handler never calls `ensureProblemsViewMarked()` — only `NotificationBell` and the two
  activity pages do (`src/server/services/notifications/view-mark.ts`, R8), so there is no code path from
  the stream to a mark;
- `problemsViewScope()` returns `null` for any path that is not `/activity` or `/p/{slug}/activity`, so
  even if the stream's path reached it, it would qualify as nothing.

The client side matches: a push calls `setState`, never `router.refresh()` (R10).

### Shape, constants and what does not change

#### S32 — Every interval and cap is a shared constant, not a setting

`src/lib/notifications/stream-protocol.ts` holds the path, the five event names, the payload codec and
every number: the probe interval, the heartbeat, the lifetime, the opening-snapshot deadline, the silence
deadline, the local-change yield, the two caps, the attempt limit and the backoff. Server and client
import the same module, so the deadline the client enforces and the heartbeat the server sends cannot
drift apart (constitution IV). FR-013 and FR-033 forbid an environment variable for any of them, and an
install that needs more capacity runs another web process (N74).

#### S30 — Nothing else moves

No table (`notification_states`, `notification_preferences`, `notification_event_marks` and
`activity_events` keep every column), no environment variable, no runtime dependency, no infrastructure,
no `docker-compose.yml` change, no `next.config.ts` change, no security-header change, no new UI atom, no
new screen and no new visible control (FR-033, FR-029, SC-010). The count route and the recent route are
untouched, so an upgrade is additive and a rollback is a client-side change.

---

## 2. Cost, restated with numbers

What N72 claims, with this plan's arithmetic behind it. Take an install with 10 open visible tabs
belonging to 6 people, one web process, and a quiet hour.

| | Today (N12) | With this entry |
|---|---|---|
| Per-person count queries | 10 tabs × 60 polls = **600/hour** | **0** (nothing changed, so no round runs) |
| HTTP requests for the count | 600/hour | 10 connects + ~120 lifetime reconnects/hour (10 tabs ÷ 270 s), each one request |
| Fixed database work | none | 1,800 probes/hour, each one statement of nine scalars |
| Latency of a new problem | up to 60 s | under 5 s (one 2-second probe + one recompute) |

When a problem *does* arrive: one round, 6 recomputes (S21 — six people, not ten tabs), ~24 indexed
statements, at most 3 at a time, and a message only to the connections whose value changed (FR-010).

The probe's own cost: scalar #1 is a single-row index-only scan (S15); the four `count(*)`s are scans of
sparse tables whose size is bounded by memberships — about one `notification_states` row, a handful of
`notification_preferences` rows and at most `EVENT_MARK_CAP` marks per membership. For a self-hosted
Docket (spec Assumption: "a handful of people") that is hundreds to a few thousand rows, read from shared
buffers. It is linear in install size rather than constant, and the honest statement of where that stops
being cheap is roughly 100,000 preference rows — about 25,000 memberships — which is far outside the scale
this product is built for and far outside what 50 streams per process would serve.

---

## 3. What this phase deliberately did not decide

- **Per-product proxy configuration.** `docs/deployment.md` §7 states what must be true and says so
  (FR-030, N78, constitution I). No nginx, Caddy, Traefik or Cloudflare recipe appears anywhere.
- **Anything about Web Push or service workers.** Out of scope by the roadmap's own words.
- **What is counted or who is notified.** `compileEligibility`, the read floor, the sparse marks and the
  switches are imported and consumed exactly as entries 1 and 2 shipped them; changing any of them would
  be a defect in this design (FR-006).
- **Email.** A push is not a send. N42–N67 are untouched.
