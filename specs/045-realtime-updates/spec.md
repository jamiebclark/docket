# Feature Specification: Real-time updates — a push stream for the problems bell, with the poll kept as its fallback

**Feature Branch**: `061-realtime-updates`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Before specifying, read .specify/roadmaps/notifications.md in full — its goal paragraph, the 'Behaviour on main that every entry builds on' bullet list (the /api/me/notifications 60-second count poll per N12, the notifications components including poll.ts and NotificationBellClient.tsx, the DAL readers and the one sanctioned cross-project reader, and the worker tick with RUN_WORKER_IN_PROCESS) and the 'Rules for every entry' list (leave the repo working and say what it does not do; explicitly reverse shipped decisions and record the replacement in docs/decisions.md next to the original; project isolation; existing UI primitives, the docket-ui skill and docs/design-system.md with screen-reader announcements only on meaningful change per N12; secrets never leak; any browser, screenshot or visual-judgement task goes last in tasks.md). Also read specs/022-problem-notifications/ and decisions N1-N12 in docs/decisions.md in full — this entry replaces N12's poll, so the spec must name that reversal and record the replacement decision.

Scope of this entry: replace N12's 60-second poll with a server push so a problem appears in the bell within seconds. Server-Sent Events over one authenticated endpoint, carrying the same payload shape the count route returns after per-event-read-state (entry 1) changed it. poll.ts and NotificationBellClient.tsx become a fallback that still works when the stream cannot connect, and the count must still render server-side with no client JavaScript at all. The deployment constraints are the entry's real content, not an afterthought: Docket is a single container behind a reverse proxy that may buffer or time out long-lived responses, may run several web processes, and RUN_WORKER_IN_PROCESS means the writer may not be the process holding the connection — so decide and record how an event reaches every connected process, how many connections one install will hold, what happens when the cap is reached, and how the stream is closed on sign-out, session expiry and membership removal. Document the proxy configuration it needs in docs/deployment.md.

Testing the author attached to this entry: auth and project scoping on the stream; a client that reconnects after a dropped connection without missing or double-counting events; fallback to polling when SSE is unavailable; the connection cap; teardown on sign-out and on membership removal; and no leak of another person's counts.

Must NOT take on: Web Push or service workers — the author calls this a separate problem (OS-level delivery, VAPID keys and a service worker lifecycle) and says it is not in this roadmap; changing what is counted or who is notified; any change to email cadence (owned by entry 3, email-delivery)."

## Context and sources

- Roadmap `.specify/roadmaps/notifications.md`, entry **4 of 4**, slug `realtime-updates`. It closes the last item on 022's own Out of Scope list — "real-time push from the server to the browser (only the 60-second refresh)" — and is deliberately last, because it changes only *how fast* the person hears, never *what* they hear.
- It consumes, unchanged, everything the first three entries settled: the per-event read and snooze state (entry 1, `specs/042-per-event-read-snooze/`, decisions **N13–N24**), the per-kind and per-platform eligibility rule (entry 2, `specs/043-notification-preferences/`, **N25–N41**) and the email channel (entry 3, `specs/044-email-delivery/`, **N42–N67**). **It adds no notion of what is counted, who is notified, or when mail goes out.** The count it pushes is the number the bell already shows, produced by the service function the count route already calls.
- **Behaviour on `main` that this feature builds on** (read from `specs/022-problem-notifications/` and decisions **N1–N67** in `docs/decisions.md`):
  - **The count is polled every 60 seconds (N12).** While the tab is visible, `poll.ts` fetches `GET /api/me/notifications` every 60 s, once when the tab becomes visible again, once on an in-page "notifications changed" event, and once more from a one-shot timer armed from the summary's `nextChangeAt` (entry 1's soonest live snooze). It stops entirely while the tab is hidden. A failure keeps the last count silently. It is pure, injectable logic with its own tests and no DOM.
  - **The payload is `UnreadSummary`**: `count`, `display` ("99+" from 100), `label` (the accessible name in words) and `nextChangeAt` (ISO instant or null). `GET /api/me/notifications` is session-only, reads no input, refuses API keys with 401 and answers `Cache-Control: private, no-store` with `Vary: Cookie`. `/api/me/` is a public prefix in the auth gate, so a cookie-less request gets 401 rather than a login redirect.
  - **The bell is server-rendered first.** `NotificationBell` renders the count on the server; `NotificationBellClient` is a plain link to `/notifications` until it hydrates, and only then becomes a disclosure button that starts the poll and opens `NotificationPanel`. The panel fetches its own rows from `GET /api/me/notifications/recent`. `router.refresh()` is never used, because it would re-render — and so re-mark — a problems view (**R10**).
  - **Announcements are made only on a meaningful change (N12).** A rise in the count is announced politely through a live region; an unchanged or lower count is not.
  - **Reads go through `src/server/dal/notifications.ts`**, whose project-set reader is the one sanctioned cross-project reader; other install-wide reads go through the named `crossProject()` escape hatch, as housekeeping, health and the scheduler already do. A test harness fails any other query on a project-owned table.
  - **The worker tick** (`/api/internal/tick`, `WORKER_INTERVAL_SECONDS`, `RUN_WORKER_IN_PROCESS`) is the only recurring server-side execution Docket has. With `RUN_WORKER_IN_PROCESS` set it runs *inside a web process*, so the process that writes a problem may be a different process from the one holding a person's connection — and with an external worker container it certainly is.
  - **The constitution forbids session-level Postgres features** — advisory locks and `LISTEN` — "because Neon's pooler is in transaction mode", and forbids new infrastructure (queues, Redis) without a justification. Docket uses `LISTEN` nowhere today.
  - **Streaming responses are supported by the installed framework.** Route handlers may return a Web `ReadableStream`, which the installed Next's own guide gives as the way to do Server-Sent Events (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`). **No `NEEDS RESEARCH` and no `NEEDS DEPENDENCY`**: the browser side is `EventSource`, which needs no package, and `connect-src 'self'` in the existing Content-Security-Policy already permits a same-origin stream.
  - **Every request passes through the proxy layer**, which sets `x-docket-path` (the problems-view marker reads it), the CSP nonce and the security headers, and refuses cross-origin mutations.
  - **The deployment shape**: one container serving port 3000 behind the operator's own reverse proxy (`docs/deployment.md` §7, which states requirements rather than per-product recipes, because none have been researched), optionally with a separate worker container, optionally on a container host with Neon.
- **Not touched by this entry**: attention events (**N1**), the read floor and sparse marks (**N13–N15**), preferences and eligibility (**N39**), email cadence, quiet hours and the mailer (**N42–N67**), the activity log and its screens, the recent-problems rows themselves, the callout, the public API, webhooks, publishing and the queue.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`, **next to the decision it replaces or extends**, as the roadmap's rules require. Numbering continues from entry 3 (N42–N67).

### The reversal

- **N12 is reversed in its first half and kept in its second.** "The browser asks for the person's current count every 60 seconds" is replaced: the server now pushes, and the poll becomes the fallback for installs and browsers where the push cannot work (**N79**, **N80**). "It announces to screen readers only when the count goes up, never on every poll" **stands unchanged** (**N70**) — it was never about the transport. Two other properties of N12 survive on purpose: a hidden tab costs nothing (**N73**) and a failure keeps the last count silently (**N80**). **Nothing migrates.** N12 wrote no data: it was a timer and a fetch, so there is no stored state to convert, no row to rewrite and no operator action on upgrade. An install that upgrades and whose proxy buffers responses behaves exactly as it does today.

### The stream, and what it carries

- **N68 — One authenticated stream endpoint per person, under `/api/me/`, carrying count snapshots and nothing else.** Session cookie only; an API key is refused with 401; no query parameter, header or body is read, so a crafted request naming another person or project cannot change what is sent. Responses are `private, no-store` with `Vary: Cookie`. The message body is exactly the shape `GET /api/me/notifications` returns — `count`, `display`, `label`, `nextChangeAt` — produced by the *same* service function, so the bell can never disagree with itself (constitution IV). Deliberately **not** on the stream: problem rows, event text, project names, account names, platform keys. The panel keeps fetching its own rows, which means a stream message cannot carry one project's problem text to a person who has just lost that project.
- **N69 — Snapshots, not increments, and that is what makes reconnection safe.** Every message is the person's whole current count, never "+1". A client that was disconnected cannot miss a count, because the next message is absolute; a client that receives the same message twice cannot double-count, because it never adds. The server sends one snapshot immediately on every connect **and** every reconnect, so "what did I miss while I was away" is answered by construction — with no replay buffer, no server-side event log, no cursor and no message ids (and therefore no `Last-Event-ID` to honour or to get wrong). The spec's "without missing or double-counting events" is thus a property of the payload, not of a protocol the implementation has to get right under load.
- **N70 — The announcement rule survives, measured against what the page last showed.** A snapshot that is higher than the last count this page displayed is announced politely through the existing live region; an equal or lower one is silent. A reconnect that re-sends an unchanged count therefore announces nothing, and a snapshot that falls because the person read something elsewhere announces nothing (**N12**, **R15**).

### How an event reaches every connected process

- **N71 — No process ever notifies another. Every process discovers the change in the database they already share.** Each web process runs **one** watcher for all the connections it holds — not one per connection — which probes a fixed handful of install-wide scalars every 2 seconds. The scalars must cover **every input the count depends on**, and must see additions, changes **and deletions**: the newest attention-event position, the read-floor rows, the sparse per-event marks, the preference switches and memberships. A newest-change instant alone cannot see a deleted row, so each input contributes a row count as well as an instant (the plan fixes the exact set and keeps it to one query). If nothing moved, and no connection's own due instant (`nextChangeAt`, entry 1's soonest live snooze) has passed, nothing is recomputed and nothing is sent. When something did move, this process recomputes the summaries of **its own** connections and sends only those whose value changed. The install-wide probe goes through the named `crossProject()` escape hatch, like housekeeping and the scheduler; every per-person recompute goes through the one sanctioned project-set reader, so project isolation is unchanged and the test harness still governs it. This answers the roadmap's three deployment constraints at once:
  - the writer never has to find the holder, so `RUN_WORKER_IN_PROCESS`, the worker container and the cron tick are all irrelevant to delivery — a problem written by *any* process, or by a person's own action in another tab, is found by every process within one probe;
  - several web processes need no coordination, no shared memory and no sticky sessions: each serves the connections it holds;
  - nothing is added to the stack — no Redis, no queue, and no Postgres `LISTEN`, which the constitution forbids outright because Neon's pooler is in transaction mode.
- **N72 — The cost stops growing with tabs, and the promise is "seconds", not "instant".** Be precise about the trade, because it is not "cheaper on every axis". The expensive query — the per-person count across their projects — moves from *once per open tab per minute* to *once per connected person per actual change*, which on an install where problems are rare is a large reduction and, at the cap, is bounded. In exchange there is a new fixed cost that N12 did not have: one small indexed probe per web process every 2 seconds (30 a minute) whether anybody is connected or not, plus the watcher itself. So the cost no longer scales with tabs, and the part that scales with people only fires when something really changed. What this design spends, besides that fixed probe, is latency: a problem reaches an open tab in about one probe interval plus a recompute, which is **under 5 seconds**, against up to 60 before. The product copy says "within seconds" and never promises instant.
- **N73 — The stream follows the visible tab.** It is opened while the tab is visible and closed when the tab is hidden, exactly where N12 stopped and started its timer; on becoming visible again the client reconnects and the opening snapshot (**N69**) is the catch-up, replacing N12's "refresh once on becoming visible". This keeps N12's one genuinely good property — a backgrounded tab costs the server nothing — and it matters more than it looks: over HTTP/1.1 a browser allows about six connections per origin, and a held stream occupies one of them, so a person with eight tabs open must not hold eight streams or their own page loads start queueing behind them.

### How many connections, and what happens at the cap

- **N74 — The caps are constants, not settings: 50 streams per web process, 5 at once per person.** An install's ceiling is therefore 50 × the number of web processes, which `docs/deployment.md` states plainly. These numbers protect a process from exhausting its database pool (default 10 connections) and its memory; they are not a policy an operator tunes, so **no environment variable is added** — an install that needs more capacity runs another web process, which this design already supports with no coordination (**N71**). The per-person cap is 5 rather than 2 because one person legitimately uses a desktop, a phone and a second browser at once; **N73** is what keeps a tab hoarder from reaching it.
- **N75 — At the person's cap their oldest stream is closed; at the process cap the newcomer is told to poll.** A person's sixth stream displaces their first, because the tab they just opened is the one they are looking at, and the displaced tab falls back to polling and loses nothing (snapshots, **N69**). When a process is full, the new request is **refused** with a plain, documented refusal the client understands as "poll instead" — never queued, never left hanging, never answered with an error page, and never served by closing an established stream belonging to somebody else. A refusal is not a failure: the person sees a bell that updates every 60 seconds, with nothing on screen about capacity.

### Proxies, heartbeats and the lifetime of a connection

- **N76 — A connection is deliberately short-lived: the server closes it after 5 minutes and the client reconnects.** A proxy read timeout, a container restart, a deploy and a rolling restart then all look like ordinary operation rather than a special case, memory and database handles cannot accumulate behind a forgotten connection, and no stale session can be served for longer than one connection's life (**N81**). A clean close is indistinguishable, to the person, from the stream staying open: the reconnect's opening snapshot arrives in well under a second.
- **N77 — A heartbeat every 20 seconds, and the client insists on the opening snapshot.** The heartbeat is an inert keep-alive that carries no data and updates nothing; it exists so a quiet stream is not closed by a proxy's or load balancer's idle timer. More importantly, it is how the client detects a **buffering** proxy: a proxy that holds the response in a buffer leaves the connection looking perfectly open while delivering nothing at all. So a client that has not received its opening snapshot within 5 seconds of connecting treats the stream as unavailable, closes it and polls (**N80**). An install behind a buffering proxy therefore degrades to today's behaviour by itself — no operator action, no error on screen, no silently frozen count.
- **N78 — The proxy configuration is documented as a requirement, not left to hope.** `docs/deployment.md` §7 gains what must be true for the stream — response buffering off for the stream, a read/idle timeout above the heartbeat interval, HTTP/1.1 or better with no response transformation — in the shape that section already uses: *what must be true*, not per-product recipes, because no proxy product has been researched (constitution I). It also says plainly that an install whose proxy cannot be changed still works on the 60-second fallback, and what the install's connection ceiling is (**N74**).

### Falling back, and the floor that needs no JavaScript

- **N79 — The poll is not deleted; it becomes the fallback, and the server-rendered count stays the floor.** Three layers, each a complete answer on its own: (1) the count rendered on the server with no client JavaScript at all, correct as of the page load, with every link in the bell and panel working — 022's **FR-014**, unchanged and still tested; (2) the 60-second visible-tab poll, unchanged in behaviour, including its `nextChangeAt` one-shot timer, whenever the stream is unavailable; (3) the stream when it works. `poll.ts` keeps its injected-environment shape and its existing tests; what changes is only *who starts it*.
- **N80 — What counts as "unavailable", and what does not.** Unavailable, and therefore a fall back to polling: no `EventSource` in the browser; a refusal at the process cap (**N75**); a connection or server failure; no opening snapshot within 5 seconds (**N77**); or more than 3 consecutive failed attempts, each backed off. The decision is remembered for that tab, so a hopeless stream is attempted once per tab rather than once per page view, and a fresh tab tries again. A failure is silent: the last known count stays on screen, exactly as N12 required. **Not** unavailable: a 401, which means the session is gone and belongs to **N81**; and an ordinary scheduled close after 5 minutes (**N76**), which is just a reconnect.
- **N81 — Sign-out, session expiry and membership removal all end the right thing, and none of them leaves a stale count on screen.** The stream re-resolves the session and the person's current memberships on every recompute and at least once a minute, and **N76** bounds any staleness at 5 minutes regardless. A session that has been signed out or has expired ends the stream with a terminal message, after which the client stops reconnecting rather than hammering a signed-out endpoint — and it cannot be rescued mid-stream, because a response whose headers have already been sent cannot carry a refreshed session cookie, which is exactly why a stream must not be the thing that keeps a session alive. Losing a membership is **not** an ending: the next snapshot is computed from the memberships the person has *now*, so that project's problems leave the count on the next push, which is the rule 022's **FR-019** already applies to page loads, reached one way instead of two.
- **N82 — A push never marks anything read and never refreshes the page.** The stream is a read-only observer: it does not run the problems-view mark (a stream request is not a problems view, and its path must never be mistaken for one), and the client never calls `router.refresh()` on a push, because that would re-render a problems view and mark it read. That is **R10**'s rule, kept deliberately.
- **N83 — An open panel is refreshed by a push, because a panel that disagrees with the bell is worse than a panel that is a second late.** When a push changes the count while the panel is open, the panel refetches its rows from the recent route it already uses. Nothing else on the page reacts to a push.
- **N84 — A snapshot yields to the person's own action for one probe interval.** When a person marks, snoozes or changes a preference, the action returns the authoritative count and the bell shows it at once — but a snapshot computed a moment before that write may still be in flight. So the client ignores stream snapshots for 2 seconds after one of its own changes, then lets the stream be authoritative again. The cost is that a genuinely new problem arriving inside that window is shown one probe later; the benefit is that the badge never flickers back to a number the person just acted on.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A problem reaches the bell in seconds (Priority: P1)

A person has Docket open in a tab while they work on something else. A post fails in one of their projects. Within a few seconds — not a minute — the bell's count goes up, its accessible name changes with it, and a screen reader hears that there are more unread problems. Nothing on the page reloads, nothing they were typing is lost, and the Activity view they happen to be looking at is not re-marked as read.

**Why this priority**: This is the entry. A minute of latency is why someone finds out about a failed post from a client rather than from Docket.

**Independent Test**: Sign in with a visible tab open, write a failed activity event in one of the person's projects from another process (the worker, the tick, or a second session), and measure the time until the badge and the accessible name change. Repeat with the writer in the same process and in a different one — both must behave identically.

**Acceptance Scenarios**:

1. **Given** a signed-in visible tab and 0 unread problems, **When** a failed event is written in one of the person's projects with that kind and platform on, **Then** within 5 seconds the badge shows "1", the accessible name reads "1 unread problem", and a screen reader hears the rise once.
2. **Given** the same tab, **When** the event is written by a *different* process from the one holding the connection (a worker container, or a tick in another web process), **Then** the push arrives just the same.
3. **Given** several web processes each holding connections for different people, **When** one problem is written, **Then** every connected person who should count it is pushed to, and nobody else receives anything.
4. **Given** a push arrives while the person is on Activity with the *Problems* preset, **When** the count updates, **Then** the page is not re-rendered or refreshed and nothing is marked read.
5. **Given** a push that leaves the count unchanged, or lowers it, **When** it arrives, **Then** the badge updates and **no** announcement is made.
6. **Given** a snoozed problem whose snooze runs out, **When** that instant passes, **Then** the count rises within 5 seconds without the person doing anything, and without any new activity event existing.
7. **Given** the person marks a problem read in this tab, **When** a snapshot computed just before that write arrives in the next 2 seconds, **Then** the badge keeps the value their action produced and does not flicker back.
8. **Given** the person marks all read in a second tab, **When** up to 5 seconds pass, **Then** this tab's badge falls to zero on its own, with no announcement.
9. **Given** the tab is hidden, **When** problems are written, **Then** this tab holds no connection and makes no requests; **When** it becomes visible again, **Then** it connects and shows the current count within a second.

---

### User Story 2 - It still works where the push cannot (Priority: P1)

An operator runs Docket behind a proxy that buffers responses, or a person uses a browser or an extension that will not hold a stream. They never find out: the bell still updates on its own, just at the old pace, and nothing on screen mentions streams, proxies or capacity. A person with no client JavaScript at all still sees a correct count on every page load and can still use every link, "Mark all as read" included.

**Why this priority**: Docket is self-hosted. The operator's proxy is not under Docket's control, and a feature that silently freezes the count on a misconfigured proxy would be worse than the poll it replaced.

**Independent Test**: Run the client against a stream that accepts the connection and sends nothing (a buffering proxy), one that refuses at the cap, one that fails the connection outright, and an environment with no `EventSource`. In each case the poll must take over within about 5 seconds, the count must keep updating every 60 s, and no error must be shown. Separately, load a page with JavaScript disabled and check the count, the links and "Mark all as read".

**Acceptance Scenarios**:

1. **Given** a stream that connects but delivers nothing for 5 seconds, **When** that deadline passes, **Then** the client closes it, starts polling, keeps showing the last known count, and shows no error.
2. **Given** a browser with no `EventSource`, **When** the bell hydrates, **Then** it polls instead, with no attempt and no error.
3. **Given** the stream is refused because the process is at its cap, **When** the client sees that refusal, **Then** it polls and shows nothing about capacity.
4. **Given** three consecutive failed connection attempts, each backed off, **When** the third fails, **Then** the client stops attempting for that tab and polls.
5. **Given** a tab that has fallen back, **When** the person navigates within Docket in that tab, **Then** it does not re-attempt the stream on every page; **When** they open a new tab, **Then** that tab attempts the stream again.
6. **Given** client JavaScript is unavailable, **When** any signed-in page loads, **Then** the count is correct as of that load, the bell is a working link, every panel link works, and "Mark all as read" works (022 FR-014).
7. **Given** polling has taken over, **When** a snooze runs out, **Then** the one-shot `nextChangeAt` timer still refreshes the count at that instant, as it does today.
8. **Given** the stream later becomes available again (a proxy is fixed, the install restarts), **When** a fresh tab is opened, **Then** it gets pushes, with no setting to change.

---

### User Story 3 - A dropped connection loses nothing and counts nothing twice (Priority: P1)

A laptop sleeps, a phone changes network, a proxy times out a long-lived response, a deploy restarts the container. The stream drops and comes back. The count is simply right afterwards — not one too many, not one too few, and not stuck.

**Why this priority**: Mobile networks and reverse proxies drop long-lived connections constantly. A transport whose correctness depends on never dropping is not a transport.

**Independent Test**: With a known number of unread problems, drop the connection, write two more problems while it is down, and let the client reconnect: the count must equal the true total exactly once, and repeating the same message must not change it. Separately, let the server close at its 5-minute lifetime and check the reconnect is invisible.

**Acceptance Scenarios**:

1. **Given** the connection drops while 2 new problems are written, **When** the client reconnects, **Then** its first message is a full current snapshot and the count equals the true total — not the total plus the two it missed.
2. **Given** the same snapshot is delivered twice, **When** both arrive, **Then** the count is unchanged by the second and only one announcement was made.
3. **Given** the server's 5-minute connection lifetime elapses, **When** the server closes the stream cleanly, **Then** the client reconnects and the person sees no change at all.
4. **Given** repeated connection drops, **When** the client reconnects, **Then** attempts are backed off rather than immediate, and a reconnect loop cannot hammer the server.
5. **Given** the install is restarted while a tab is open, **When** it comes back, **Then** the tab reconnects on its own and shows the current count without a page reload.
6. **Given** a client reconnects, **When** it does, **Then** it sends no resume cursor and the server needs no history to answer correctly.

---

### User Story 4 - The stream cannot become a way to read someone else's counts (Priority: P1)

A new always-open, session-authenticated endpoint is the kind of thing that leaks. It must return only the caller's own count, computed from the caller's own current memberships, with nothing it is told from the outside having any effect.

**Why this priority**: The count crosses projects. A scoping mistake here would push one project's — or one person's — state to someone outside it, continuously.

**Independent Test**: Open the stream with no session, an expired session, an API key, and a valid session carrying crafted parameters and headers naming another person and other projects. Check every response. Then, with two people connected at once to the same process, check that each one's messages only ever carry their own count.

**Acceptance Scenarios**:

1. **Given** no session or an expired one, **When** the stream is opened, **Then** it is refused as unauthenticated, no stream is established and no count is disclosed.
2. **Given** a public-API key instead of a session, **When** the stream is opened, **Then** it is refused; API keys belong to projects, not people.
3. **Given** a valid session and query parameters, headers or a body naming another user, project or count, **When** the stream runs, **Then** they are ignored entirely and only the caller's own count is sent.
4. **Given** two people connected to the same process, **When** problems are written in a project only one of them belongs to, **Then** only that person's stream receives anything.
5. **Given** a person in a project they have muted (all kinds off) or whose kind or platform is switched off, **When** such a problem is written, **Then** no push is sent to them and their count does not change — the stream uses the same eligibility rule as the bell (N39), not its own.
6. **Given** any response from the endpoint, **When** it is inspected, **Then** it is marked not cacheable and varies by cookie, and carries no project name, account name, message text, event id or person's address.
7. **Given** the stream's per-person recomputation, **When** the project-scope test harness observes its queries, **Then** every project-owned query is pinned to one project or goes through the sanctioned project-set reader, and the install-wide probe uses the named cross-project escape hatch.

---

### User Story 5 - Signing out, expiring and being removed all end it (Priority: P1)

When a person signs out, their open tabs stop receiving anything. When their session expires, the same. When they are removed from a project, that project's problems leave their count without them reloading anything.

**Why this priority**: A held connection is a held authorisation decision. If it is never re-checked, "remove member" and "sign out" stop meaning what they say.

**Independent Test**: With a stream open, sign out in another tab, expire the session in the database, and remove the membership — each independently — and observe the open stream in each case.

**Acceptance Scenarios**:

1. **Given** an open stream, **When** the person signs out in another tab, **Then** within a minute the stream is ended by the server with a terminal message and the client stops reconnecting.
2. **Given** an open stream, **When** the session expires, **Then** the stream ends the same way, and no refreshed session can be established over the open response.
3. **Given** a client that has been told the session is gone, **When** it would otherwise reconnect, **Then** it does not, and it does not start polling a signed-out endpoint either.
4. **Given** an open stream and unread problems in project A, **When** the person is removed from A, **Then** the next push excludes A's problems, within 5 seconds, with no reload; and if A was their only project, the count becomes 0.
5. **Given** a person removed from a project, **When** their stream recomputes, **Then** it reads their memberships as they are now and never a set cached when the connection opened.
6. **Given** a removal that is rolled back (for example the last owner), **When** the next push arrives, **Then** the count is unchanged.
7. **Given** a person's project has its notifications turned fully off from another device, **When** the next push arrives, **Then** their count reflects it.

---

### User Story 6 - An install stays within known bounds (Priority: P2)

The operator can tell what this feature costs them: how many connections one install holds, what happens when that is reached, and what their proxy has to allow. A busy install does not fall over; it falls back.

**Why this priority**: This is a self-hosted product on a single container behind someone else's proxy. "It works on my machine with one tab" is not a deployment.

**Independent Test**: Open connections up to the per-process cap and one more; open six for one person; and run a seeded install with many idle connections while measuring the database work the watcher does. Read `docs/deployment.md` and check it states the buffering, timeout and ceiling facts.

**Acceptance Scenarios**:

1. **Given** a process holding its maximum streams, **When** one more is requested, **Then** it is refused with the documented refusal, no established stream is closed, and no error is logged as a fault.
2. **Given** a person with 5 open streams, **When** they open a sixth, **Then** their oldest is closed, the sixth is served, and the closed tab falls back to polling.
3. **Given** 50 idle connections on one process, **When** the watcher probes, **Then** the database work per probe is the same as with one connection, and per-person counts are recomputed only when something in the install actually changed.
4. **Given** a quiet stream, **When** 20 seconds pass with nothing to send, **Then** a heartbeat is sent so an idle proxy does not close it, and the heartbeat changes nothing on screen.
5. **Given** `docs/deployment.md`, **When** the reverse-proxy section is read, **Then** it states that the stream must not be buffered, what read/idle timeout it needs, that the install's ceiling is the per-process cap times the number of web processes, and that an install that cannot change its proxy still works on the 60-second fallback.
6. **Given** an install running several web processes, **When** a problem is written, **Then** every process serves its own connections correctly with no shared state, no sticky sessions and no process-to-process messaging.

---

### Edge Cases

- **A proxy that buffers but also keeps the connection open for ever** looks healthy and delivers nothing: the opening-snapshot deadline (N77) is what catches it, not the heartbeat.
- **HTTP/1.1's six-connections-per-origin limit**: a held stream occupies one, so the visible-tab rule (N73) is a correctness measure, not an optimisation — without it a person with many tabs starves their own page loads. An install served over HTTP/2 is unaffected; `docs/deployment.md` says so.
- **A tab that is visible but idle for hours** sees connection after connection (N76) with no visible effect, and makes no announcement because the count never rose.
- **A problem written and then marked read within one probe interval** is never pushed as a rise, because the probe sends the state at probe time, not every intermediate state. The bell is a count, not a feed.
- **Two problems within one probe interval** arrive as one snapshot that went up by two, and one announcement.
- **The watcher's own probe fails** (a database blip): nothing is sent, the last count stays, and the next probe recovers. A failing probe never closes connections and is never shown to the person.
- **A connection whose recompute fails** keeps the connection and retries on the next probe; it does not send a wrong count and does not drop the person to polling.
- **The database pool is exhausted** while connections are held: because the watcher is one per process and per-person recomputes are rare and short, held connections hold no database handle between recomputes.
- **A person in no projects**, or whose every project is fully off, holds a stream that only ever sends zero — and the panel's existing empty states are unchanged.
- **A tab left open across a deploy**: the old container closes its connections, the client reconnects to the new one, and the first snapshot comes from the new code.
- **A second sign-in as a different person in the same browser** replaces the cookie; the open stream re-resolves the session on its next check, finds a different person, and ends rather than sending the previous person's counts.
- **A tab left open for days** must not keep a session alive for ever. The stream's session re-check is read-only with respect to the session's expiry (FR-022): the person's browser cannot receive a refreshed cookie over a response whose headers were sent, so a stream that renewed the session would be renewing something the browser can no longer prove.
- **Clock skew between a snooze instant and the probe** can only make a snoozed problem return a probe interval late, never early: due instants are the stored absolute instants entry 1 already resolved (M8).
- **A stream request whose path is mistaken for a problems view** would mark problems read as a side effect of merely watching. It must not be, and a test pins it (N82).
- **Prefetching and preloading** are irrelevant to the stream (no navigation is involved), and the prefetch rules for problems links (R9) are untouched.

## Requirements *(mandatory)*

### Functional Requirements

**The stream endpoint**

- **FR-001**: The system MUST offer one session-authenticated endpoint that holds a long-lived response and delivers the caller's unread-count snapshots as server-sent events. It MUST live under the existing personal-API prefix so a cookie-less request is refused rather than redirected to a login page.
- **FR-002**: The endpoint MUST refuse a caller with no session, an expired session, or a public-API key, without establishing a stream and without disclosing any count. It MUST read no input: no query parameter, header or body naming a person, project or count may have any effect (N68).
- **FR-003**: Every message MUST carry exactly the payload shape `GET /api/me/notifications` returns — the count, its capped display, its accessible name in words, and the next-change instant or null — and MUST be produced by the same service function that route uses, so the two can never disagree (N68, constitution IV).
- **FR-004**: Messages MUST carry no problem row, event id, project name, account name, platform key, message text or person's address (N68). Responses MUST be marked not cacheable and varying by cookie, and MUST never be shared between callers.
- **FR-005**: The stream MUST send one snapshot immediately on connect and on every reconnect, MUST send no message id and MUST require no resume cursor; delivery MUST be idempotent, so a repeated or missed message cannot change the count the person sees (N69).
- **FR-006**: A snapshot MUST be computed from the caller's current memberships and the same eligibility rule the bell uses — the project roll-up, the per-kind switch, the per-platform switch, the read floor and sparse marks (N1, N15, N39). The stream MUST NOT introduce any second notion of what is counted or who is notified.
- **FR-007**: Reading for the stream MUST obey project isolation: every project-owned query pinned to one project or routed through the one sanctioned project-set reader, and any install-wide probe through the named cross-project escape hatch. It MUST pass the project-scope test harness.

**Delivery across processes**

- **FR-008**: An attention event MUST reach every process holding a connection that should see it, whichever process wrote it — including the worker container, an external cron tick, and a tick running in-process in another web process (N71). The design MUST NOT require process-to-process messaging, shared memory, sticky sessions, Postgres `LISTEN`, or any new infrastructure.
- **FR-009**: Each web process MUST run exactly one watcher for all of its connections, and MUST NOT run one per connection. Its probing work MUST be independent of the number of open connections; recomputation MUST happen only on an actual change and MUST be bounded by the connection cap (N71, N72). The watcher MUST bound how many recomputes it runs at once, so a process holding its full complement of connections cannot exhaust the database pool or starve ordinary page requests.
- **FR-010**: A per-person count MUST be recomputed only when the install-wide probe shows something changed, or when a connection's own next-change instant has passed. The probe MUST detect additions, changes **and deletions** across every input the count depends on — attention events, the read floor, sparse per-event marks, preference switches and memberships — so that a removed membership or a deleted mark is seen as readily as a new event (N71). A message MUST be sent only when the snapshot differs from the one that connection last received, in either the count or the next-change instant.
- **FR-011**: A person's count MUST update without a new activity event when the cause is their own read, snooze, preference or membership change made anywhere — another tab, another device, or a server action in another process (N71).
- **FR-012**: A snooze running out MUST raise the count within the same few seconds as a new problem, driven by the connection's next-change instant (N71, entry 1's `nextChangeAt`).

**Connections, caps and lifetime**

- **FR-013**: A web process MUST serve at most 50 concurrent streams, and one person MUST hold at most 5 at once. No new environment variable may be introduced for either; the install's ceiling is the per-process cap times the number of web processes (N74).
- **FR-014**: At the per-person cap, the person's oldest stream MUST be closed and the new one served. At the per-process cap, the new request MUST be refused in a way the client recognises as "fall back to polling" — never queued, never left hanging, never an error page, and never by closing another person's established stream (N75).
- **FR-015**: The server MUST close each connection cleanly after at most 5 minutes, and the client MUST reconnect with no visible effect (N76).
- **FR-016**: The server MUST send an inert heartbeat at least every 20 seconds so an idle proxy does not close a quiet stream. A heartbeat MUST change nothing on screen and MUST announce nothing (N77).
- **FR-017**: The stream MUST be held only while the tab is visible: closed when it becomes hidden, re-opened when it becomes visible, with the opening snapshot as the catch-up (N73). A hidden tab MUST hold no connection and make no requests.

**Fallback, and the no-JavaScript floor**

- **FR-018**: The server-rendered count MUST remain correct as of page load with no client JavaScript at all, and every link in the bell and panel plus "Mark all as read" MUST keep working without it (022 FR-014, N79).
- **FR-019**: The existing 60-second visible-tab poll MUST remain a working fallback, unchanged in behaviour — its interval, its refresh on becoming visible, its in-page change event, its `nextChangeAt` one-shot timer, its silent failure handling and its pure injectable shape with existing tests (N79). Only what starts it may change. Exactly one of the two refresh mechanisms MUST be running at any moment: while a stream is connected and healthy the poll MUST NOT also run, and while polling no stream may be held.
- **FR-020**: The client MUST fall back to polling when: `EventSource` is unavailable; the stream is refused at the cap; the connection or server fails; no opening snapshot arrives within 5 seconds; or more than 3 consecutive attempts fail, each backed off. The fallback MUST be remembered for that tab so a hopeless stream is attempted once per tab rather than once per page view, and MUST be silent — no error, no toast, no capacity message, last known count kept (N80).
- **FR-021**: A 401 MUST NOT be treated as "unavailable": it means the session is gone, and the client MUST stop reconnecting rather than switching to polling a signed-out endpoint (N80, N81).

**Teardown**

- **FR-022**: The stream MUST re-resolve the caller's session and current memberships on every recompute and at least once a minute, and MUST NOT cache either for the life of the connection (N81). That re-check MUST NOT extend the session's own lifetime: a held stream cannot deliver a refreshed session cookie to the browser, so a stream that renewed the session server-side would keep a session alive that the person's browser can no longer prove it has.
- **FR-023**: A session that has been signed out or has expired MUST end the stream with a terminal message, after which the client MUST stop reconnecting. The stream MUST NOT be able to refresh or extend the session over an already-started response (N81).
- **FR-024**: Losing a membership MUST NOT end the stream: the next snapshot MUST be computed from the memberships the person has now, so that project's problems leave the count within the same few seconds, with no reload (N81, 022 FR-019). A rolled-back removal MUST leave the count unchanged.

**The bell, the panel and announcements**

- **FR-025**: A push MUST update the badge and the bell's accessible name, and MUST announce politely **only** when the count rises above what the page last displayed (N12's surviving half, N70).
- **FR-026**: A push MUST NOT re-render or refresh the page, and MUST NOT mark anything read — in particular a stream request MUST NOT be treated as a problems view (N82, R9, R10).
- **FR-027**: When a push changes the count while the panel is open, the panel MUST refetch its rows from the existing recent route so the rows and the count cannot disagree (N83). Nothing else on the page may react to a push.
- **FR-028**: For 2 seconds after one of the person's own changes in this tab (mark read, snooze, preference, mark all), the client MUST ignore stream snapshots, so the badge never flickers back to a value they just acted on (N84).
- **FR-029**: The bell, panel and callout MUST keep their existing appearance, keyboard behaviour, focus handling, labels and live-region use per the docket-ui skill and `docs/design-system.md`. No new UI atom is expected; this entry adds no visible control and no new screen.

**Documentation and decisions**

- **FR-030**: `docs/deployment.md` §7 MUST state what the stream needs from a reverse proxy — response buffering off for it, a read/idle timeout above the heartbeat interval, HTTP/1.1 or better with no response transformation — in that section's existing "what must be true, not per-product recipes" style, plus the install's connection ceiling, the HTTP/1.1 per-origin connection note, and that an install that cannot change its proxy still works on the 60-second fallback (N78).
- **FR-031**: The notifications documentation (the "Notifications" section of `docs/activity.md`) MUST say that the count now arrives by push within seconds, that it falls back to a 60-second refresh by itself when the push cannot work, and that no setting controls any of it.
- **FR-032**: `docs/decisions.md` MUST record N68–N84 **next to** the decisions they replace or extend, and MUST record the N12 reversal in place: the poll half replaced, the announcement half standing, and nothing to migrate because N12 stored no data (roadmap rules).
- **FR-033**: No new environment variable, runtime dependency, infrastructure component or `docker-compose.yml` change may be introduced by this entry.

**Tests**

- **FR-034**: Tests MUST cover:
  - **auth and scoping**: no session, expired session, API key, and crafted parameters or headers naming another person or project; two people on one process; a muted project, an off kind and an off platform producing no push; project-scope harness compliance for every query the stream makes;
  - **no leak**: a message body carrying only the count shape, with no project, account, message, event id or address; responses not cacheable and cookie-varying;
  - **reconnection**: a drop with problems written while down, giving a correct count exactly once; the same snapshot twice changing nothing and announcing once; backed-off reconnects; a clean close at the lifetime boundary being invisible; no resume cursor required;
  - **fallback**: no `EventSource`; a stream that connects and sends nothing (the buffering proxy) falling back on the deadline; a refusal at the cap; three failed attempts; the fallback remembered per tab; the poll's existing behaviour unchanged, including the `nextChangeAt` one-shot; the no-JavaScript count, links and "Mark all as read";
  - **the caps**: the process cap refusing a newcomer without closing anyone; a person's sixth stream closing their oldest; watcher database work independent of connection count;
  - **teardown**: sign-out, session expiry, a second person signing in to the same browser, membership removal changing the next snapshot, a rolled-back removal changing nothing, and a session never extended over an open stream;
  - **cross-process delivery**: a problem written by a process that holds no connection reaching every process that does; a snooze expiry pushing with no new event; a read in another tab lowering the count;
  - **the UI rules**: announce on a rise only; no page refresh and nothing marked read on a push; an open panel refetching; the 2-second yield after a local change.

### Key Entities

- **Count snapshot**: the person's whole current unread summary at a moment — count, capped display, accessible name, next-change instant. Not stored; computed on demand by the existing service function. Absolute, never an increment.
- **Connection**: one person's live stream held by one web process, carrying the person's resolved identity, the last snapshot sent and its own next-change instant. Lives in that process's memory only, for at most 5 minutes, and is never shared or persisted.
- **Watcher**: one per web process. Probes the install for change, recomputes the summaries of that process's connections when something changed, sends what differs. Holds no per-person state beyond its connections.
- Existing entities referenced, unchanged in meaning: activity event, attention event, notification state (floor and mute roll-up), per-event mark, preference switch, project, member, user, session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new problem in a project a person is notified about appears in their open, visible tab's bell in **under 5 seconds**, measured in a seeded test, against up to 60 seconds today — including when the writer is a different process from the connection holder.
- **SC-002**: A snooze running out, a read in another tab and a membership removal each change the count in an open tab within the same 5 seconds, with no page reload.
- **SC-003**: In tests, 100% of reconnections produce the correct count exactly once: zero missed counts after a drop with events written while down, and zero double-counts from a repeated snapshot.
- **SC-004**: With 50 idle connections on one process, the database work the watcher does per probe is the same as with one connection, and per-person counts are recomputed only on an actual change — so on an install with 10 open tabs and a quiet hour, the number of per-person count queries falls from 600 an hour to zero, at the cost of a fixed 1,800 cheap probes an hour per web process.
- **SC-005**: In every unavailable condition (a browser that cannot hold a stream, a proxy that buffers one, a refusal at the connection cap, repeated connection failures), the 60-second refresh takes over within **5 seconds**, the count keeps updating at that pace, and nothing about streams, proxies or capacity appears on screen.
- **SC-006**: With no client JavaScript at all, the count is still correct on every page load and every link and "Mark all as read" still work — unchanged from today.
- **SC-007**: In tests, zero messages reach a person for a project they do not currently belong to, have fully turned off, or whose kind or platform is off; and zero messages carry another person's count or any project, account, message or address text.
- **SC-008**: Signing out or letting a session expire ends every stream for it within a minute, and the client makes no further attempt; a connection outlives its session by at most its 5-minute lifetime.
- **SC-009**: An operator reading `docs/deployment.md` can state, without reading code, what the proxy must allow, how many connections their install will hold, and what happens if their proxy buffers.
- **SC-010**: The entry adds no environment variable, no dependency, no infrastructure and no new screen or control.

## Assumptions

- **Single-install scale.** A self-hosted Docket serves a handful of people; 50 streams per web process and 5 per person are generous for that, and an install that needs more runs another web process. No autoscaling or multi-region case is considered.
- **A 2-second probe interval is the latency floor** this design offers, and "within seconds" is the promise made in the UI and the docs. If a future entry needs sub-second delivery it will need a different mechanism, and this entry's decisions say so plainly.
- **The install-wide probe is cheap** because it reads two indexed scalars: the newest attention-event position and the newest notification-state change. The plan confirms both are index-backed by the indexes 022's R4 and entry 1 already added, or adds one if not.
- **Problems are rare.** Per-person recompute cost is bounded by how often anything in the install changes, which for failures, ambiguities and reauths is a handful of times a day on a normal install; the cap bounds the worst case.
- **The browser's `EventSource` is sufficient** — no package, no polyfill, no service worker. Its automatic reconnection is used where it helps and overridden where this entry needs its own rules (the opening-snapshot deadline, the attempt limit, the terminal end).
- **`connect-src 'self'` in the existing Content-Security-Policy already permits the stream**, so no security-header change is expected; the plan verifies it.
- **The count route and the recent route stay as they are.** The stream is an addition; nothing that works today is removed, so an upgrade is safe and a rollback is a client-side change only.
- **Session validity is readable cheaply** on the server, as the existing per-request session read is.
- **No table change is expected**, and no data migrates (the reversed half of N12 stored nothing). If the plan shows the probe needs an index, it ships as a committed SQL migration with `pnpm db:check` green and safe to apply to a live install with existing rows, and no operator may be asked to reset notification state (roadmap rules).
- **Nothing in this entry needs a browser to verify its logic**: the server rules, the client state machine and the fallback are all testable headlessly with an injected environment, exactly as `poll.ts` is today. Any screenshot or visual-judgement task goes last in `tasks.md`, after everything automated (roadmap rules).

## Out of Scope

- **Web Push and service workers.** Reaching a person whose browser is closed is a different problem — OS-level delivery, VAPID keys, a service worker lifecycle and a permission prompt — and the roadmap places it outside this roadmap entirely. Nothing here registers a service worker or asks for notification permission.
- **Changing what is counted or who is notified.** Attention events (N1), the read floor and sparse marks (N13–N15) and the eligibility rule (N39) are consumed unchanged.
- **Any change to email**: cadence, digests, quiet hours, the mailer and the delivery log belong to entry 3 (`email-delivery`, N42–N67) and are untouched. A push is not a send.
- **Pushing anything other than the count**: no live problem rows, no live Activity, no live queue, no live Failures screen, no cross-page live updates. The panel still fetches its rows when it opens.
- **An operator setting for the stream** — no on/off switch, no interval, no cap variable. The client's automatic fallback is the escape hatch (N80).
- **Per-product reverse-proxy recipes.** `docs/deployment.md` states requirements; no proxy product has been researched (constitution I).
- **Changing the activity log, its screens, its filters, the public API or webhooks.**

This is the roadmap's **last** entry, so nothing above is handed on to a later entry in it: each item is either outside the roadmap by the author's own words (Web Push and service workers), owned by an entry that has already shipped (email, preferences, read state), or deliberately never to be built. The repo is left working either way — an install that takes this entry and whose proxy buffers responses behaves exactly as it does today.
