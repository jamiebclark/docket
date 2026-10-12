# Quickstart — real-time updates

**Feature**: `specs/045-realtime-updates/` · **Branch**: `061-realtime-updates` · **Date**: 2026-10-12

How to run this and how to prove it. Design detail is in [plan.md](./plan.md),
[research.md](./research.md), [data-model.md](./data-model.md) and
[contracts/](./contracts/stream.md); nothing is repeated here.

---

## 1. Prerequisites

Nothing new. No environment variable, no dependency, no infrastructure, no `docker-compose.yml` change
(FR-033, SC-010). The ordinary development setup is enough:

```bash
pnpm install
docker compose up -d postgres          # or any Postgres via DATABASE_URL
pnpm db:migrate                        # applies 0023: one additive partial index
pnpm db:check                          # must be green
pnpm seed                              # a person, a project, some activity
pnpm dev
```

`pnpm dev` serves on `http://localhost:3000`. Nothing is buffering in front of it, so the stream works
immediately; §2.3 is how to see the fallback instead.

---

## 2. Running it

### 2.1 Watch a problem arrive

1. Sign in and leave a tab open on any page (the bell is in the header everywhere).
2. In a second terminal, write a failed activity event in one of that person's projects — the worker tick,
   a second session, or a seeded insert will all do.
3. The badge changes **within 5 seconds**, its accessible name changes with it, and a screen reader hears
   the rise once. Nothing reloads and nothing you were typing is lost (US1).

To see it from a *different* process, set `RUN_WORKER_IN_PROCESS=false` and run the worker separately, or
call the tick endpoint from cron. The push arrives identically: no process notifies another, every process
discovers the change in the database they share (N71, US1 §2).

### 2.2 Watch the wire

```bash
curl -N -H "Cookie: <your session cookie>" http://localhost:3000/api/me/notifications/stream
```

Expected: a `snapshot` frame at once, a `ping` every 20 seconds, a `snapshot` only when the count changes,
and a `reconnect` frame followed by a close at 4.5 minutes. `-N` matters — without it curl buffers and you
see nothing, which is a neat demonstration of exactly what N77 is about.

Check the headers too (`curl -I` will not work on a stream; use `-D -`): `text/event-stream`,
`private, no-store`, `Vary: Cookie`, `Content-Encoding: identity`, no `Content-Length`.

### 2.3 Watch the fallback

Put anything in front of it that buffers — the simplest is a one-line proxy with buffering on, but you do
not need one: `curl` without `-N` and a browser behind a buffering reverse proxy behave the same way from
Docket's point of view.

Expected, in every unavailable case: within about 5 seconds the bell starts updating every 60 seconds
instead, the last known count never disappears, and **nothing** about streams, proxies or capacity appears
anywhere on screen (US2, SC-005).

To see the no-JavaScript floor, disable JavaScript and reload: the count is correct as of that load, the
bell is a working link, every panel link works and "Mark all as read" works (US2 §6, SC-006).

---

## 3. The checks that prove it

```bash
# the whole feature
pnpm vitest run tests/integration/notifications src/lib/notifications src/components/notifications src/server/services/notifications
```

| User story | Check |
|---|---|
| **US1** A problem reaches the bell in seconds | `tests/integration/notifications/stream-delivery.test.ts` — a seeded write, the measured time to the message, the writer in the same process and in another; a snooze expiring with no new event; a read in a second tab lowering the count; the push not re-rendering or marking a problems view |
| **US2** It still works where the push cannot | `src/components/notifications/refresh.test.ts` — no `EventSource`; a stream that connects and sends nothing, falling back on the 5-second deadline; a refusal at the cap; three backed-off attempts; the fallback remembered per tab and forgotten in a fresh one; `poll.test.ts` unchanged and still green, including its `nextChangeAt` one-shot; `ui.test.tsx` for the no-JavaScript count, links and "Mark all as read" |
| **US3** A dropped connection loses nothing and counts nothing twice | `stream-reconnect.test.ts` — a drop with two problems written while down, giving the true total exactly once; the same snapshot twice changing nothing and announcing once; a clean close at the lifetime boundary being invisible; backed-off reconnects; **no `id:` frame is ever written and no `Last-Event-ID` is ever read** |
| **US4** The stream cannot leak another person's counts | `stream-authz.test.ts` — no session, an expired session, an API key, and a valid session carrying crafted parameters and headers naming another person and other projects; two people on one process; a muted project, an off kind and an off platform producing no push. `stream-payload.test.ts` — the body shape and the full never-on-the-wire list. `stream-scope.test.ts` — the harness sees nothing unpinned and exactly two named cross-project reasons |
| **US5** Signing out, expiring and being removed all end it | `stream-teardown.test.ts` — sign-out, expiry, a second person signing in to the same browser, a membership removal changing the next snapshot without ending the stream, a rolled-back removal changing nothing, a project turned fully off from elsewhere, and **the session's `expires_at` unchanged** after a stream has lived through several re-checks |
| **US6** An install stays within known bounds | `stream-caps.test.ts` — the process cap refusing a newcomer with the documented refusal and closing nobody; a person's sixth stream closing their oldest; the statement count per probe identical with 1 and with 50 connections. `tests/integration/docs/` — `docs/deployment.md` states the buffering, timeout, ceiling and fallback facts |

Unit-level, no database and no DOM:

| File | Covers |
|---|---|
| `src/lib/notifications/stream-protocol.test.ts` | The frame codec, a malformed or truncated frame being dropped rather than shown, and that no `id:` or `retry:` is ever emitted |
| `src/server/services/notifications/stream/registry.test.ts` | Both caps, oldest-first displacement, idempotent removal |
| `src/server/services/notifications/stream/watcher.test.ts` | A round that sends nothing; a due `nextChangeAt` with an unchanged fingerprint; one recompute per person for several tabs; the concurrency bound; a probe failure leaving the baseline alone; a recompute failure keeping its connection |
| `src/components/notifications/refresh.test.ts` | Every transition in [contracts/client.md](./contracts/client.md) §3, the announcement baseline across both legs, and the 2-second yield |

Migration:

```bash
pnpm vitest run tests/integration/notifications/stream-migration.test.ts
pnpm db:check
```

`0023` on a seeded install with existing rows: the index exists, no floor, mark, switch or event changed,
and nothing needed an operator step.

---

## 4. Measurements

| Claim | How it is measured |
|---|---|
| **SC-001/SC-002** under 5 seconds | A seeded test records the instant of the write and the instant of the message, for a new problem, a snooze expiry, a read elsewhere and a membership removal |
| **SC-003** 100% of reconnections correct exactly once | `stream-reconnect.test.ts` asserts the count equals the true total after a drop with writes during it, and that a repeated snapshot changes nothing |
| **SC-004** probe work flat at 50 connections | `queryObservers` (`src/server/db/client.ts:16`) counts statements per probe with 1 and with 50 registered connections; the two must be equal. The same test asserts zero per-person count queries across a quiet interval |
| **SC-005** fallback within 5 seconds | The client test clock measures entry into `polling` from each unavailable condition |
| **SC-007** zero leaked messages | `stream-authz.test.ts` and `stream-payload.test.ts` |
| **SC-008** every stream ends within a minute of sign-out | `stream-teardown.test.ts` drives the 60-second re-check timer; the 270-second lifetime is the absolute bound |
| **SC-009** an operator can answer from the docs | `tests/integration/docs/` asserts the four facts are present in `docs/deployment.md` §7 |

---

## 5. The by-hand walk-through — **last**

Everything above is headless. This is the only part that needs eyes, and per the roadmap rule it is the
final task in `tasks.md`, after all automated work is green.

In a real browser, signed in:

1. Leave a tab open and write a problem from elsewhere. Watch the badge change by itself, with no flicker
   and no layout shift.
2. Open the panel, then write another problem. The rows refetch and the badge and rows agree (FR-027).
3. Mark one problem read in the panel, then wait. The badge does not flicker back to the old number
   (FR-028).
4. Leave the tab open for ten minutes. Two scheduled reconnects happen; nothing visible occurs and a
   screen reader says nothing.
5. Background the tab for a minute, then return. The count is current within a second and nothing was
   requested while it was hidden (FR-017).
6. Sign out in a second tab. The first tab stops updating and makes no further requests.
7. With a screen reader on, confirm a rise is announced once and a fall is silent (FR-025).

Record what was seen in the entry's review notes. Nothing in steps 1–7 is a substitute for §3; they are a
check that the automated proof matches what a person experiences.
