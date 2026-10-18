# Contract — reading `X-Business-Use-Case-Usage` (FR-045, FR-048)

[research §4](../research.md) · FR-044 … FR-048

The impressions-based limit cannot be computed locally; the only authoritative signal is the header
Meta returns on every response. **Docket discards it today**: `send()` in
`src/providers/meta/graph.ts` reads `res.status` and `res.text()` and never touches `res.headers`,
and `GraphOutcome` has no field for it. This is the one change this entry makes to the shared Graph
transport, and it is deliberately the smallest one that can work.

---

## §1 The parsed shape — two integers, and nothing else

New module `src/providers/meta/usage.ts`:

```ts
/** The only thing that leaves the header. Two bounded integers: no key, no id, no raw text. */
export interface UsageSignal {
  /** The largest of call_count / total_cputime / total_time across every id, 0-100 (clamped). */
  maxPercent: number;
  /** The largest estimated_time_to_regain_access in minutes, or null when none was reported. */
  retryAfterMinutes: number | null;
}

/** Pure and total. Null when the header is absent, unparseable or carries no usable number. */
export function parseUsageHeader(value: string | null): UsageSignal | null;
```

**Why only two integers.** FR-048 forbids recording any header value that could carry a token. The
header is keyed by object id and its documented fields are three percentages, a `type`, an
`estimated_time_to_regain_access` and `ads_api_access_tier` (§Q6). Reducing it to two clamped numbers
at the parse boundary means **nothing** from the header can reach a log, a `last_error`, a snapshot or
a panel — the property holds by construction, so no scrubbing step can be forgotten. The object ids
in the keys are Page and Instagram ids, not secrets, but they are also not information Docket needs,
so they are dropped too.

**Parsing rules** (each a unit test; the function is pure, so these are cheap):

- `null`, `""`, non-JSON, or JSON that is not an object → `null`.
- For every key, for every entry in its array value: take `call_count`, `total_cputime`,
  `total_time` where each is a finite number; `maxPercent` is the maximum, clamped to `[0, 100]`.
  Meta documents these as percentages, but a value above 100 is not impossible, and a clamp keeps the
  comparison with the ceiling total.
- `retryAfterMinutes` is the maximum finite `estimated_time_to_regain_access`, clamped to
  `[0, 1440]` — a day is already far past any poll schedule, and an unclamped value from a malformed
  reply must not be able to park an account for a year.
- No usable number anywhere → `null`, which the caller treats as "no signal", not as "zero usage".

## §2 The transport change

```ts
// src/providers/meta/graph.ts
export type GraphOutcome =
  | { kind: "ok"; status: number; body: unknown; usage?: UsageSignal }
  | { kind: "graph_error"; status: number; error: GraphError; usage?: UsageSignal }
  | { kind: "http_error"; status: number; usage?: UsageSignal }
  | { kind: "unparseable"; status: number; usage?: UsageSignal }
  | { kind: "network"; phase: "before_send" | "after_send" };   // no response, no header
```

`send()` gains one line before it returns — `const usage = parseUsageHeader(res.headers.get("x-business-use-case-usage")) ?? undefined;`
— attached to each arm that has a response. Optional on every arm, so:

- **every existing caller is unchanged** and every existing Graph test still compiles and passes;
- the publish path gets the field for free and ignores it, which is correct for this entry — FR-045
  is about insights reads, and changing what publishing does with a throttle signal is explicitly out
  of scope ("Any change to publishing … is out of scope");
- a mocked response with no header yields `undefined`, which is the common case in existing tests.

`graphSummary` gains `usagePercent` when present — a number, so the `AttemptSummary` stays
secret-free by the same construction.

## §3 How a reader uses it (FR-045)

```ts
const ceiling = metaUsageCeiling();                // META_INSIGHTS_USAGE_CEILING, default 80
if (outcome.usage && outcome.usage.maxPercent >= ceiling) {
  return {
    kind: "rate_limited",
    error: `Meta reports this account is at ${outcome.usage.maxPercent}% of its call budget.`,
    ...(outcome.usage.retryAfterMinutes !== null
      ? { retryAt: new Date(now.getTime() + outcome.usage.retryAfterMinutes * 60_000) }
      : {}),
  };
}
```

Checked **after** a successful read as well as after an error, and **before** the next call in the
same batch, so:

1. a 200 whose header says 85% still stops the subsystem for that account (US6-AS1) — the signal
   arrives on success, which is the only way to back off *before* exhaustion rather than after it;
2. the numbers that response carried are **still committed** — it was a successful read, and throwing
   away data Docket already paid a call for would be the wrong kind of caution. `rate_limited` is
   returned on the *next* iteration, so the batch commits what it has and stops;
3. `retryAt` flows into `nextPollAt` through the existing `rate_limited` arm of `commitPostBatch`,
   which already prefers `result.retryAt` over `nextRetryAt(...)` — **no scheduler change needed**;
4. with no header, the declared floor and the per-account reserve still bound the work (US6-AS4), and
   `maxPercent` of exactly the ceiling counts as reached (`>=`), because the alternative leaves the
   last percent unprotected for no benefit.

The same shape applies on the Threads path with `THREADS_INSIGHTS_USAGE_CEILING`; Threads' responses
come through its own transport, so the parser is imported (it is Meta's header either way) and the
transport change is made there too, in the same two lines.

## §4 What is deliberately not built

- **No cross-tick usage memory.** The signal is used within the tick that received it; the next tick
  gets a fresh header on its first call. A stored percentage would be a second source of truth with a
  staleness window, for a signal Meta hands over for free on every response.
- **No pre-emptive budget arithmetic.** Docket does not try to compute `4800 × impressions`; that is
  precisely the number it does not know (research §4).
- **No change to publishing's handling of 80001/80002.** Already classified `rate_limited` and
  already retried (research §5.1).
