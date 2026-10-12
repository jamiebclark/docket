# Contract — the client: one supervisor, the poll untouched

**Feature**: `specs/045-realtime-updates/` · **Date**: 2026-10-12

One new module, `src/components/notifications/refresh.ts`, with the same injected-environment shape and
the same no-DOM test style `poll.ts` already has. Two existing components gain a few lines each.
`poll.ts` is **not edited** (FR-019, N79).

---

## 1. The module

```ts
export interface RefreshEnv {
  // --- the stream leg ---
  hasEventSource: () => boolean;
  openStream: (path: string) => StreamHandle;      // a thin EventSource wrapper, injectable
  // --- the fallback leg ---
  pollEnv: () => PollEnv;                          // poll.ts's own environment, plus a merged onChanged (§4)
  fetchSummary: () => Promise<FetchResult>;        // the 401 probe and the fallback's own fetch
  // --- the tab ---
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  /** Per-tab, not per-page: a module-level flag, so a navigation does not forget it (FR-020). */
  getFallbackMemo: () => boolean;
  setFallbackMemo: (value: boolean) => void;
  // --- time ---
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  random: () => number;                            // backoff jitter, injectable so tests are deterministic
}

export interface StreamHandle {
  on: (event: StreamEventName, listener: (data: string) => void) => void;
  onError: (listener: () => void) => void;
  close: () => void;
}

export type FetchResult =
  | { kind: "ok"; summary: UnreadSummary }
  | { kind: "unauthenticated" }                    // HTTP 401 — FR-021's terminal verdict
  | { kind: "failed" };

export interface RefreshHandlers {
  onSummary: (summary: UnreadSummary) => void;
  /** Only when the count rose above what the page last displayed (N70, FR-025). */
  onAnnounce: (summary: UnreadSummary) => void;
  /** A snapshot changed the count: the panel, if open, refetches its rows (FR-027). */
  onPanelRefresh: () => void;
}

export interface RefreshHandle {
  /** The person just changed something in this tab: ignore stream snapshots for 2 s (FR-028). */
  noteLocalChange: (summary?: UnreadSummary) => void;
  stop: () => void;
}

export function startRefreshing(initial: UnreadSummary, env: RefreshEnv, handlers: RefreshHandlers): RefreshHandle;
export function browserRefreshEnv(): RefreshEnv;
```

---

## 2. States

Five. FR-019's "exactly one refresh mechanism at any moment" is a property of the state set, not a rule
that has to be remembered.

| State | Stream held | Poll running | Entered when |
|---|---|---|---|
| `hidden` | no | no | The tab is hidden (FR-017) |
| `connecting` | yes | **no** | A connect attempt is in flight, awaiting the opening snapshot |
| `streaming` | yes | **no** | The opening snapshot arrived |
| `polling` | **no** | yes | Any unavailable condition, and every backoff window |
| `ended` | no | no | The session is gone (FR-021, FR-023) |

`lastShown` — the summary the page is currently displaying — is kept across every transition and is the
one baseline both legs measure a rise against (§5).

---

## 3. Transitions

| From | Trigger | To | Notes |
|---|---|---|---|
| start / `hidden` | tab becomes visible **and** `!getFallbackMemo()` **and** `hasEventSource()` | `connecting` | Arms `OPENING_SNAPSHOT_DEADLINE_MS` (5 s) |
| start / `hidden` | tab becomes visible **and** (`getFallbackMemo()` \|\| `!hasEventSource()`) | `polling` | No attempt, no error (FR-020, US2 §2, US2 §5) |
| any | tab becomes hidden | `hidden` | Close the stream, stop the poll, clear every timer. A hidden tab holds no connection and makes no requests (FR-017, N73, US1 §9) |
| `connecting` | `snapshot` received | `streaming` | Clear the deadline, arm `SILENCE_DEADLINE_MS` (45 s), reset the failure count |
| `connecting` | 5-second deadline elapses | `polling` | The buffering-proxy case: close, remember the fallback, show no error (N77, US2 §1) |
| `connecting` | `onError` | probe, then → | §3.1 |
| `connecting`/`streaming` | `unavailable` | `polling` | Remember the fallback for this tab (S8, FR-014) |
| `connecting`/`streaming` | `ended` | `ended` | Stop. Never reconnect, never poll (FR-021, FR-023, US5 §3) |
| `streaming` | `snapshot` | `streaming` | §5, §6 |
| `streaming` | `ping` | `streaming` | Re-arms the silence watchdog and nothing else (FR-016) |
| `streaming` | `reconnect` | `connecting` after `CLEAN_RECONNECT_DELAY_MS` (500 ms) | Not a failure; the failure count stays reset (FR-015, US3 §3) |
| `streaming` | 45-second silence | `connecting` after backoff | Counted as a failure (S17) |
| `streaming` | `onError` | probe, then → | §3.1 |
| `polling` | backoff timer, when attempts remain | `connecting` | Stops the poll first, so the two never overlap |
| `polling` | the poll's own fetch returns 401 | `polling` | Unchanged from today: the last count stays, silently (N12, N80). The terminal verdict comes from §3.1 |

### 3.1 On `onError`, how the client learns why (S12)

`EventSource` exposes neither the status code nor the body, so:

1. `close()` the source;
2. make **one** request to the existing `GET /api/me/notifications`:
   - `unauthenticated` → `ended`. Stop, do not reconnect, do not poll a signed-out endpoint (FR-021);
   - `ok` → the session is live, so this was the stream's own failure. Deliver the summary (it is a free,
     fresh count) and go to 3;
   - `failed` → go to 3;
3. count a failure. If `attempts < MAX_CONNECT_ATTEMPTS` (3), go to `polling` and arm the next attempt at
   `FAILURE_BACKOFF_MS[attempts - 1]` (1 s, then 2 s) with jitter. Otherwise `setFallbackMemo(true)` and
   stay in `polling` for the life of the tab (FR-020, US2 §4).

A connection that **did** deliver its opening snapshot and then failed within `FLAPPING_MS` (2 s) counts as
a failure too; one that lived longer does not, and reconnects at 500 ms. Every reconnect is delayed, so a
drop loop cannot hammer the server (US3 §4).

### 3.2 What is never shown

No error, no toast, no banner, no "capacity" message, no mention of streams or proxies, anywhere, in any
state. The last known count simply stays on screen (FR-020, N80, SC-005). The only thing a person can
notice is that the number sometimes updates in seconds and sometimes in a minute.

---

## 4. The fallback leg, without touching `poll.ts`

On entering `polling`:

1. `startPolling(lastShown, env.pollEnv(), { onSummary, onAnnounce })` — `poll.ts` unchanged, including its
   60-second interval, its refresh on becoming visible, its `nextChangeAt` one-shot and its silent failure
   handling (FR-019, US2 §7);
2. pull the supervisor's own trigger so the poll refreshes **once immediately**, rather than waiting up to
   60 seconds.

Step 2 needs no edit to `poll.ts`: `env.pollEnv()` returns a `PollEnv` whose `onChanged` subscribes to
*both* the existing `docket:notifications-changed` window event and an internal emitter the supervisor
owns. That is `poll.ts`'s documented "refresh once on an in-page change" path, used for what it is for
(S26).

On leaving `polling`, the stop function `startPolling` returned is called before any stream is opened, so
no moment exists with both running.

---

## 5. Announcements — one baseline, two legs

The rule is unchanged: announce politely **only** when a count is higher than what the page last displayed
(N12's surviving half, N70, FR-025).

- `poll.ts` keeps its own rise check, exactly as it is;
- the supervisor applies the same rule to stream snapshots against `lastShown`;
- whenever the supervisor starts the poll, it starts it from `lastShown`, so the two baselines are the same
  number.

Therefore: a reconnect's identical opening snapshot announces nothing (US3 §2); a snapshot that falls
because the person read something elsewhere updates the badge silently (US1 §5, US1 §8); switching legs
can neither re-announce a count already on screen nor miss a rise across the switch.

`lastShown` is updated on every delivered summary, from either leg.

---

## 6. The 2-second yield (FR-028, N84)

`noteLocalChange()` records `now()`. A `snapshot` whose arrival is within `LOCAL_CHANGE_YIELD_MS` (2 s) of
that moment is **dropped**: not shown, not announced, and `lastSent`-equivalent bookkeeping is untouched,
so the next snapshot after the window is delivered normally.

Called by the bell for every locally-originated change:

| Caller | Path |
|---|---|
| A row's "Mark read" or "Snooze" | `NotificationPanel`'s `onRowDone` → `onSummary` (already returns the authoritative count) |
| "Mark all as read" | `NotificationPanel`'s `markAction` result effect |
| The in-page change event | `docket:notifications-changed` (another component's mutation) |

The poll leg is **not** yielded to: its fetch always happens after the write that triggered it, so it
cannot carry a stale value.

Cost, as the spec states it: a genuinely new problem arriving inside the window is shown one probe later.
Benefit: the badge never flickers back to a number the person just acted on (US1 §7).

---

## 7. `NotificationBellClient.tsx`

The diff is small and nothing visual changes.

```diff
-import { browserPollEnv, startPolling } from "@/components/notifications/poll";
+import { browserRefreshEnv, startRefreshing } from "@/components/notifications/refresh";
```

| Change | Requirement |
|---|---|
| The one `useEffect` that starts the refresh calls `startRefreshing` instead of `startPolling`, with the same `onSummary`/`onAnnounce` handlers plus `onPanelRefresh` | FR-019, FR-025 |
| Keep the handle in a ref; `onSummary` from the panel also calls `handle.noteLocalChange()` | FR-028 |
| New state `panelKey: number`, bumped by `onPanelRefresh`, passed to `<NotificationPanel refreshKey={panelKey} …/>` | FR-027 |
| **Unchanged**: the hydration gate and the plain `<a href="/notifications">` before it, the badge, the `sr-only` label, `role="status" aria-live="polite"`, `aria-haspopup`/`aria-expanded`/`aria-controls`, the Escape / pointer-down / focus-in dismissal, focus return to the button | FR-018, FR-029 |
| **Never added**: `router.refresh()` | FR-026, R10 |

## 8. `NotificationPanel.tsx`

```diff
-export function NotificationPanel({ onSummary }: { onSummary: (summary: UnreadSummary) => void }) {
+export function NotificationPanel({ onSummary, refreshKey }: { onSummary: (s: UnreadSummary) => void; refreshKey: number }) {
…
-  }, [attempt]);
+  }, [attempt, refreshKey]);
```

One prop in the dependency array of the fetch effect it already has (`refreshKey` sits beside the
`attempt` the "Try again" button already bumps), so a push makes the open panel refetch its rows from
`GET /api/me/notifications/recent` — the route it already uses — and the rows can never disagree with the
badge (N83, FR-027). Its `role="status" aria-live="polite"` region, its focus handling and its empty states
are untouched.

Nothing else on any page subscribes to a push (FR-027).

---

## 9. No-JavaScript floor

Untouched, and re-tested rather than assumed (FR-018, 022 FR-014, US2 §6, SC-006):

- `NotificationBell` is a server component and renders the count on the server;
- before hydration, and for ever without client JavaScript, the bell is a plain link to `/notifications`;
- every link in the bell and the panel works, and "Mark all as read" works, as a form submit;
- no new control, no new screen, no new UI atom; `docs/design-system.md` and the `docket-ui` skill need no
  change (FR-029, SC-010).

---

## 10. Test seams

| Seam | Why |
|---|---|
| Whole `RefreshEnv` injected — including `openStream`, `fetchSummary`, `now`, `random` and the two fallback-memo accessors | Every transition in §3 is driven with no DOM, no network and no real clock, exactly as `poll.test.ts` drives `poll.ts` |
| `random` injected | The backoff jitter is deterministic in tests |
| A fake `StreamHandle` in `tests/helpers/stream.ts` | Emits `snapshot`, `ping`, `reconnect`, `unavailable`, `ended` and errors on demand; and a variant that accepts the connection and sends nothing, which is the buffering proxy (US2 §1) |
| `hasEventSource: () => false` | US2 §2, with no attempt and no error |
| `getFallbackMemo`/`setFallbackMemo` as functions, not a module global | US2 §5: remembered across a navigation in the same tab, forgotten in a fresh one |
| `onPanelRefresh` as a handler | FR-027 is asserted without rendering the panel |
