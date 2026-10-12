# Contract — the server: admission, the registry, the watcher, the connection

**Feature**: `specs/045-realtime-updates/` · **Date**: 2026-10-12

Four new modules under `src/server/services/notifications/stream/` and two tiny readers under
`src/server/dal/`. The split exists so each piece is testable on its own: the registry is pure over an
injected clock, the watcher is pure over an injected probe and recompute, and only `connection.ts` and
`index.ts` touch a `Response`.

---

## 1. Admission — `index.ts`

```ts
export async function openNotificationStream(request: Request): Promise<Response>;
```

Exactly this order, and the order matters (S9):

| # | Step | On failure |
|---|---|---|
| 1 | `const session = await getSession()` | null → **401** `{"error":"unauthenticated"}` (contracts/stream.md §2.2). An API key is not a session, so it lands here with no extra code |
| 2 | If the person already holds `MAX_STREAMS_PER_PERSON` (5), end their **oldest** by `openedAt` with `unavailable: displaced` | — |
| 3 | If the process now holds `MAX_STREAMS_PER_PROCESS` (50), answer the one-event **refusal** (contracts/stream.md §2.3) | — |
| 4 | `registry.add(connection)` | — |
| 5 | `summary = await unreadSummary(await forMyProjects(session))` | throws → deregister, **500** `{"error":"unavailable"}` |
| 6 | Build the `ReadableStream`; its `start` writes `frame("snapshot", summary)` and sets `lastSent` | — |
| 7 | Arm the heartbeat, lifetime and session-re-check timers (§4) | — |
| 8 | `ensureWatcher()` | — |

Step 2 before step 3 means a person at their own cap is never refused by a full process for a slot they
were about to free themselves. Step 5 after steps 2–4 means a refused request costs **no** count query.

The handler **never** calls `ensureProblemsViewMarked()` — nothing in this folder imports it — so a stream
request cannot mark anything read (FR-026, N82, S31).

`request` is used for nothing but its `signal`, which is wired as a best-effort fast path (§4.4). Nothing
is read from its URL, headers or body (FR-002).

---

## 2. The registry — `registry.ts`

Pure over an injected `now()`; no database, no `Response`, no timers. Its own unit test covers every cap
case.

```ts
export interface StreamConnection {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly openedAt: number;
  lastSent: { count: number; nextChangeAt: string | null };
  write(frame: string): boolean;            // false once the client has gone
  end(event: "reconnect" | "unavailable" | "ended", reason?: string): void;
}

export interface StreamRegistry {
  /** Full? Then nothing is added and the caller answers the documented refusal. */
  add(connection: StreamConnection): "added" | "process_full";
  /** The person's oldest, when they already hold the per-person maximum; otherwise null. */
  overflowing(userId: string): StreamConnection | null;
  remove(id: string): void;
  size(): number;
  /** Grouped by user id, so one recompute serves a person's tabs (S21). */
  byUser(): Map<string, StreamConnection[]>;
  all(): StreamConnection[];
}

export function getRegistry(): StreamRegistry;        // Symbol.for singleton
export function resetRegistryForTests(): void;
```

| Rule | Requirement |
|---|---|
| `add` refuses at 50 and **never** closes an established connection to make room | FR-014, US6 §1 |
| `overflowing` returns the oldest by `openedAt`, so the tab the person just opened is the one that is served | FR-014, N75 |
| `remove` is idempotent — a double teardown is normal (a guarded write failing *and* an abort firing) | S19 |
| The map is process-local and under `Symbol.for("docket.notifications.stream")`, so a hot reload cannot create two | S23 |

---

## 3. The watcher — `watcher.ts`

```ts
export interface WatcherDeps {
  probe: () => Promise<ChangeFingerprint>;
  recompute: (userId: string) => Promise<UnreadSummary>;
  sessionIsLive: (c: { sessionId: string; userId: string }) => Promise<boolean>;
  registry: StreamRegistry;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;   // reuse abortableSleep
  log: (line: string) => void;
}

/** One round. Exported separately so a test drives it without a loop or a clock. */
export async function runRound(deps: WatcherDeps): Promise<RoundSummary>;

/** Starts the loop if it is not running. Called by the first connection. */
export function ensureWatcher(deps?: Partial<WatcherDeps>): void;

/** Stops when the last connection goes, and on SIGTERM. */
export function stopWatcher(): void;
```

### 3.1 One round

```
1. fingerprint = await probe()                    ── failure: §3.3
2. due = any connection whose lastSent.nextChangeAt is non-null and <= now()
3. if fingerprint === baseline and not due:  return (nothing sent)
4. for each [userId, connections] of registry.byUser(), at most MAX_CONCURRENT_RECOMPUTES at a time:
     a. if not await sessionIsLive(one of them):  end each with `ended`;  continue
     b. summary = await recompute(userId)         ── failure: §3.3
     c. for each connection:
          if summary.count !== lastSent.count || summary.nextChangeAt !== lastSent.nextChangeAt:
            write frame("snapshot", summary);  lastSent = { … }
5. baseline = fingerprint
```

| Property | Requirement |
|---|---|
| Entered on a fingerprint change **or** a passed due instant — so a snooze running out raises a count with no new event and no fingerprint change | FR-012, US1 §6 |
| One recompute per **person**, not per connection | S21, N72 |
| A message only when the value differs from that connection's own `lastSent` | FR-010, US1 §5 |
| At most 3 recomputes at once, against `DATABASE_POOL_MAX` default 10 | FR-009, S22 |
| `baseline` is assigned only after a successful probe (step 5 never runs on the §3.3 path) | S24 |
| Probe work per round is one statement whatever `registry.size()` is | FR-009, SC-004 |

### 3.2 The loop

`probe → round → sleep to the next PROBE_INTERVAL_MS boundary`, sequential, so rounds never overlap and a
slow round delays the next probe instead of piling up. On the **first** probe, `baseline` is `null`: it is
stored and no round runs, because every connection already received its own opening snapshot (FR-005).

`ensureWatcher()` is called by each new connection and is a no-op when the loop is running.
`registry.remove()` calls `stopWatcher()` when the size reaches zero (S23). `SIGTERM` ends every
connection with `reconnect` and then stops the loop, which is what makes a deploy look like an ordinary
reconnect (US3 §5).

### 3.3 Failures

| Failure | What happens | Requirement |
|---|---|---|
| `probe()` throws | Nothing is sent, `baseline` is **not** replaced, the next round still sees the change. No connection is closed and nobody is told | Edge Cases, S24 |
| `recompute(userId)` throws | That person's connections keep their `lastSent` and are retried next round. No wrong count is sent, nothing is closed, nobody is dropped to polling | Edge Cases |
| `sessionIsLive` throws | Treated as *live* — a database blip must not sign anybody out. The 270-second lifetime bounds any staleness regardless | N81, FR-015 |
| `write` throws | The client has gone: deregister and clear that connection's timers | S19 |
| Logging | One line at most per minute across all failure kinds, with no user id, no count and no parameter | VII |

---

## 4. One connection — `connection.ts`

```ts
export function createConnection(input: {
  userId: string; sessionId: string;
  enqueue: (chunk: string) => void;   // the ReadableStream controller, wrapped
  close: () => void;
}): StreamConnection;
```

### 4.1 Writing

Every write is `try`/`catch`. A throw means the consumer has gone: `write` returns `false`, the connection
deregisters and its timers are cleared. Nothing in the design asserts that `request.signal` aborts on
client disconnect or that `ReadableStream.cancel()` fires on a dropped socket — neither is documented in
the installed Next docs, so neither is relied on (S19, constitution I).

### 4.2 Heartbeat

Every `HEARTBEAT_MS` (20 s), `write(frame("ping"))`. Because writes are guarded, this is also the liveness
check: a vanished client is reaped within one heartbeat, which is what keeps the connection cap honest
(FR-016, S19).

### 4.3 Lifetime

At `CONNECTION_LIFETIME_MS` (270 s): `write(frame("reconnect"))`, then close and deregister. 4.5 minutes
rather than 5 so Docket is always the party that closes first under the 300-second read timeout that is
the common proxy and Node default (FR-015, S18).

### 4.4 Session re-check

On its own `SESSION_RECHECK_MS` (60 s) timer **and** at the top of every recompute (§3.1a), so the
guarantee is "every recompute and at least once a minute" (FR-022). Gone → `write(frame("ended", {reason:
"unauthenticated"}))`, close, deregister (FR-023).

`request.signal`'s `abort` and the stream's `cancel()` both call `remove(id)` as best-effort fast paths:
when they fire, the slot is freed immediately; when they do not, §4.1 and §4.3 cover it.

### 4.5 Never

No write of any kind to the database. No `router.refresh()` equivalent. No `Set-Cookie`. No session
refresh. No marking read. No reading of the request's URL, headers or body.

---

## 5. The two DAL readers

### 5.1 `src/server/dal/notification-probe.ts`

```ts
export interface ChangeFingerprint { readonly value: string }

/** The nine install-wide scalars in one statement. Caller wraps in the named escape hatch. */
export async function readChangeFingerprint(db: Database): Promise<ChangeFingerprint>;
```

The statement and the justification for each scalar are in [data-model.md](../data-model.md) §2. Called
as:

```ts
crossProject("notifications stream: install probe", () => readChangeFingerprint(getDb()))
```

It reads four aggregates and one `max(seq)` and touches no per-person data. It is the **only** install-wide
statement in the whole feature (FR-007).

### 5.2 `src/server/dal/sessions.ts`

```ts
/** Read-only. Never refreshes, never extends, never writes a cookie (FR-022, S20). */
export async function sessionIsLive(db: Database, input: { sessionId: string; userId: string }): Promise<boolean>;
```

```sql
SELECT 1 FROM session WHERE id = $1 AND user_id = $2 AND expires_at > now()
```

Wrapped by the caller in `crossProject("notifications stream: session re-check", …)`. `session` is in
`notProjectOwned`, so no pin is required; the named reason exists so the harness and an auditor can see
every install-wide read this feature makes.

---

## 6. The recompute, unchanged

```ts
const summary = await unreadSummary(await forMyProjects({ user: { id: userId } }));
```

The identical expression `GET /api/me/notifications/route.ts` uses. Consequences
([data-model.md](../data-model.md) §3):

- the eligibility rule, the read floor, the sparse marks and the switches are whatever entries 1 and 2
  shipped — the stream has no second notion of what is counted (FR-006, US4 §5);
- memberships and preferences are resolved afresh every time and never cached for the life of a connection
  (FR-022, FR-024, US5 §4-§7);
- every project-owned statement is already pinned or inside the one sanctioned project-set reader, so
  there is no new query shape to audit (FR-007, US4 §7).

---

## 7. Cross-project reasons

Exactly two, and a test asserts no third appears (FR-007, US4 §7):

| Reason | Statement |
|---|---|
| `notifications stream: install probe` | §5.1, the fingerprint |
| `notifications stream: session re-check` | §5.2, the session row |

Plus the two `forMyProjects()` already produces — `resolve my projects` and the `activity: my projects`
project set — unchanged and already governed.

---

## 8. Test seams

| Seam | Why |
|---|---|
| `resetRegistryForTests()` | A test starts from an empty process |
| `runRound(deps)` exported separately from the loop | Rounds are driven directly, with no sleeping and no real clock |
| `WatcherDeps` fully injectable (`probe`, `recompute`, `sessionIsLive`, `now`, `sleep`, `log`) | The watcher's decisions are unit-tested with no database; the integration tests inject the real ones |
| `ensureWatcher({ … })` accepts overrides | An integration test can lower the probe interval or count probes |
| `tests/helpers/stream.ts` | Reads a `Response`'s body as decoded SSE frames, with a deadline |
| `tests/helpers/auth.ts` gains a real `session` row | The re-check needs something to read; the default `actAs` session id exists in no table |
| `queryObservers` (existing) | Counting the statements a round makes, for SC-004's "flat at 50 connections" |
