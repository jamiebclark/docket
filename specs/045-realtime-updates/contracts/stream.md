# Contract — the wire: one stream endpoint

**Feature**: `specs/045-realtime-updates/` · **Date**: 2026-10-12

Everything in this document is `src/lib/notifications/stream-protocol.ts` plus the route handler
`src/app/api/me/notifications/stream/route.ts`. The protocol module is imported by **both** the server and
the client, so the deadline the client enforces and the heartbeat the server sends are one fact (S32).

---

## 1. The endpoint

```
GET /api/me/notifications/stream
```

| | |
|---|---|
| Methods | `GET` only. Anything else is the framework's 405; no `POST`, `PUT` or `DELETE` exists |
| Authentication | The session cookie, and nothing else. A public-API key is refused (FR-002, US4 §2) |
| Input | **None.** No query parameter, no header and no body is read. There is nothing to craft (FR-002, US4 §3) |
| Route config | `export const dynamic = "force-dynamic"`, as both sibling routes already declare |
| Auth gate | `/api/me/` is a public prefix (`src/lib/auth-gate.ts:6`), so a cookie-less request gets 401 rather than a redirect to `/login` (FR-001) |
| Public API | Nothing. No `/api/v1` operation, no webhook event, no API-key permission (FR-033) |

The handler is three lines: it delegates to `openNotificationStream(request)` in
`src/server/services/notifications/stream/`, which is where admission and framing live
([contracts/server.md](./server.md)).

---

## 2. Responses

### 2.1 The stream — 200

| Header | Value | Why |
|---|---|---|
| `Content-Type` | `text/event-stream; charset=utf-8` | SSE |
| `Cache-Control` | `private, no-store` | FR-004; the same value both sibling routes send |
| `Vary` | `Cookie` | FR-004: a response can never be shared between callers |
| `Content-Encoding` | `identity` | The installed Next *would* gzip a `text/event-stream`, and a buffering gzip stream is the failure N77 exists to catch. Verified opt-out (S2) |
| `X-Accel-Buffering` | `no` | nginx-family proxies read it. Every other proxy is covered by the documented requirement (S3, FR-030) |

**Deliberately absent**: `Content-Length` (a stream has none, which is also what makes the transfer
chunked); `Connection` (meaningless on HTTP/1.1, illegal on HTTP/2); any `ETag`; any `Set-Cookie` — a
stream never refreshes a session (FR-022). `X-Content-Type-Options: nosniff` is already applied to
`/:path*` by `next.config.ts`.

### 2.2 Unauthenticated — 401

Byte for byte the refusal `GET /api/me/notifications` already gives, so there is one answer for no
session, an expired session and an API key (FR-002, S10):

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
Cache-Control: private, no-store
Vary: Cookie

{"error":"unauthenticated"}
```

No stream is established and no count is disclosed.

### 2.3 Refused at the process cap — 200, one event, then close

Not a 503. `EventSource` surfaces neither a status code nor a body on a failed connect, so a status-coded
refusal is indistinguishable from a network failure; FR-014 requires a refusal the client *recognises*
(S7):

```
event: unavailable
data: {"reason":"busy"}

```

then the response closes. It holds no connection, carries no count, says nothing about capacity and is not
an error page. Nothing is queued and no established stream belonging to anybody else is touched
(FR-014, N75).

### 2.4 Unexpected failure — 500

If resolving the session or computing the opening snapshot throws, the connection is deregistered (freeing
its slot) and the response is:

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json
Cache-Control: private, no-store
Vary: Cookie

{"error":"unavailable"}
```

The same shape the sibling routes use. The client treats it as a connect failure: back off, retry, and
fall back after three attempts (FR-020). The reason is logged server-side without a user id or a count.

---

## 3. Frames

Five event names, all exported from the protocol module. **No `id:` field is ever sent**, which is what
makes the browser omit `Last-Event-ID`: there is no cursor to honour and none to get wrong (FR-005). **No
`retry:` field**, because the client drives its own reconnection (S11).

Every frame is `event:` then `data:` then a blank line, UTF-8.

### 3.1 `snapshot` — the count

```
event: snapshot
data: {"count":3,"display":"3","label":"3 unread problems","nextChangeAt":null}

```

The body is exactly `UnreadSummary` as `JSON.stringify` produces it from the **same**
`unreadSummary(await forMyProjects(session))` the count route calls — four fields, no more (FR-003).
Sent once immediately on connect and on every reconnect, and thereafter only when a recompute differs from
what this connection last received, in the count or the next-change instant (FR-010).

A client that receives the same snapshot twice cannot double-count, because it never adds; a client that
missed one cannot be behind, because the next one is absolute (N69).

### 3.2 `ping` — the heartbeat

```
event: ping
data:

```

Every 20 seconds. Named rather than an SSE comment, because a comment keeps the socket warm but dispatches
nothing to `EventSource`, so a client could not use it; a named event does both jobs (S6). It carries no
data, changes nothing on screen and announces nothing (FR-016).

### 3.3 `reconnect` — the scheduled close

```
event: reconnect
data:

```

Written at the 270-second lifetime (S18) and on `SIGTERM`, immediately before the response closes. It is
what tells the client this close is ordinary: reconnect after a short delay, and do **not** count it as a
failure (FR-015, US3 §3, US3 §5).

### 3.4 `unavailable` — poll instead

```
event: unavailable
data: {"reason":"busy"}
```
```
event: unavailable
data: {"reason":"displaced"}
```

`busy` is the process cap (§2.3). `displaced` is the person's own cap: their sixth stream closes their
oldest, which receives this and falls back (N75, FR-014). Either way the client polls, remembers the
fallback for that tab, and shows nothing about capacity. The memory matters: without it six tabs would
displace each other round-robin for ever (S8).

`reason` is advisory, for logs and tests. A client that does not recognise a reason still polls.

### 3.5 `ended` — the session is gone

```
event: ended
data: {"reason":"unauthenticated"}

```

Written when the session re-check finds the row deleted, expired or belonging to somebody else, then the
response closes (FR-023, US5 §1-§3). The client stops: it does **not** reconnect, and it does **not**
start polling a signed-out endpoint (FR-021).

### 3.6 Frame order

```
snapshot            ← always first, within the first few hundred milliseconds
(ping | snapshot)*  ← ping every 20 s; a snapshot only when the value changed
reconnect | ended   ← at most one, immediately before the close
```

A stream may also simply drop with no terminal frame (a proxy timeout, a container kill, a lost network).
That is the ordinary case the client's watchdog and backoff handle (S17, S25).

---

## 4. What is never on the wire

Checked by `tests/integration/notifications/stream-payload.test.ts` over every frame of every event type
(FR-004, SC-007):

no problem row · no event id · no activity message text · no project id, slug or name · no account id or
name · no platform or provider key · no person's name, email or address · no session token, cookie or
session id · no user id · no cursor, sequence number or `Last-Event-ID` · no counts belonging to anybody
but the caller.

The panel keeping its own row fetch is what makes this structural rather than careful: a stream message
*cannot* carry one project's problem text to somebody who has just lost that project, because it carries
no text at all (N68).

---

## 5. Constants

All in `src/lib/notifications/stream-protocol.ts`. **None of them is an environment variable** (FR-013,
FR-033); an install that needs more capacity runs another web process (N74).

| Name | Value | Used by | Requirement |
|---|---|---|---|
| `STREAM_PATH` | `/api/me/notifications/stream` | both | FR-001 |
| `PROBE_INTERVAL_MS` | `2_000` | server | N71, N72 |
| `HEARTBEAT_MS` | `20_000` | server | FR-016 |
| `CONNECTION_LIFETIME_MS` | `270_000` | server | FR-015, S18 |
| `SESSION_RECHECK_MS` | `60_000` | server | FR-022 |
| `MAX_STREAMS_PER_PROCESS` | `50` | server | FR-013 |
| `MAX_STREAMS_PER_PERSON` | `5` | server | FR-013 |
| `MAX_CONCURRENT_RECOMPUTES` | `3` | server | FR-009, S22 |
| `OPENING_SNAPSHOT_DEADLINE_MS` | `5_000` | client | FR-020, N77 |
| `SILENCE_DEADLINE_MS` | `45_000` | client | S17 |
| `LOCAL_CHANGE_YIELD_MS` | `2_000` | client | FR-028, N84 |
| `MAX_CONNECT_ATTEMPTS` | `3` | client | FR-020 |
| `FAILURE_BACKOFF_MS` | `[1_000, 2_000]` (jittered) | client | FR-020, US3 §4 |
| `CLEAN_RECONNECT_DELAY_MS` | `500` | client | FR-015, US3 §4 |
| `FLAPPING_MS` | `2_000` | client | S25 — a stream that dies within this of its snapshot counts as a failure |

The install's ceiling is `MAX_STREAMS_PER_PROCESS × (number of web processes)`, which
`docs/deployment.md` §7 states plainly (FR-030, N74).

---

## 6. Codec

Pure, no DOM, no Node API, tested by `src/lib/notifications/stream-protocol.test.ts`.

```ts
export type StreamEventName = "snapshot" | "ping" | "reconnect" | "unavailable" | "ended";

/** Server side: one frame, ready to enqueue. Never emits `id:` or `retry:`. */
export function frame(event: StreamEventName, data?: unknown): string;

/** Client side: the parsed body of one received event. Unknown names and malformed JSON are ignored. */
export function parseSnapshot(data: string): UnreadSummary | null;
export function parseReason(data: string): string | null;
```

`parseSnapshot` returns `null` for anything that is not the four-field shape with a numeric `count`, so a
malformed or truncated frame can never put a wrong number on the badge — it is simply dropped and the last
known count stays (N80).
