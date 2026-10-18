# Contract: tick summary and section outcomes

**Feature**: 079 | Changes the response body of `POST /api/internal/tick`, the contents of
`scheduler_heartbeats.last_summary`, and the scheduler's own log line.

## Compatibility rule

**Additive only.** `counts` keeps its current shape on all nine sections; `outcome` is new. The 216
pinned `runTick` call sites and every existing `counts` assertion must keep compiling and passing
without edits. Where a count is *split* (`email`'s `skipped`), the old key stays and equals the sum of
the new ones.

## `TickSummary`

```ts
export interface TickSummary {
  tickId: string;
  startedAt: string;            // ISO 8601, UTC
  durationMs: number;
  publishing: SectionResult<PublishingCounts>;
  tokenRefresh: SectionResult<RefreshCounts>;
  generation: SectionResult<GenerationCounts>;
  housekeeping: SectionResult<HousekeepingCounts>;
  webhooks: SectionResult<WebhookCounts>;
  email: SectionResult<EmailCounts>;
  standingSeries: SectionResult<StandingSeriesCounts>;
  engagementRead: SectionResult<EngagementReadCounts>;
  engagementSend: SectionResult<EngagementSendCounts>;
}
```

`SectionResult<C>` and `SectionOutcome` are defined in [data-model.md](../data-model.md#1-section-outcome).

## `POST /api/internal/tick`

Unchanged in every respect except the body. Still `Bearer` only, still refuses a secret in the query
string, still one shape for every refusal, still `503 { error: "tick_failed" }` on a throw.

**200 response** (abridged; nine sections, one shown of each kind):

```json
{
  "tickId": "9f1c…",
  "startedAt": "2026-10-17T14:02:11.000Z",
  "durationMs": 1840,
  "publishing": { "ok": true, "outcome": { "kind": "completed" }, "counts": { "done": 2, "failed": 0, "…": 0 } },
  "tokenRefresh": { "ok": true, "outcome": { "kind": "declined", "reason": "insufficient_time" },
                    "counts": { "claimed": 3, "refreshed": 0, "failed": 0, "deferred": 0, "lost": 0, "outOfBudget": 3 } },
  "email": { "ok": true, "outcome": { "kind": "declined", "reason": "disabled" },
             "counts": { "claimed": 0, "sent": 0, "skipped": 0, "…": 0 } },
  "housekeeping": { "ok": true, "outcome": { "kind": "idle" }, "counts": { "…": 0 } }
}
```

**Guarantees**

- `outcome.kind` is present on every section, on both `ok: true` and `ok: false`.
- `outcome.reason` appears only when `kind === "declined"`, and only with one of the three literals.
- No value in `outcome` is derived from any input: it is selected from literals (FR-024).
- An operator reading one response can tell idle from declined, and declined-for-time from
  declined-for-configuration, without any other source (FR-021).

## Section count additions

| Section | Added | Why |
|---|---|---|
| `tokenRefresh` | `claimed: number`, `lost: number` | `failed: 0` is today consistent with "not claimed", "claimed then lease lost" and "provider returned ok". These two make the next failure name which (FR-029, US6). |
| `email` | `skippedStale`, `skippedEmpty`, `skippedOutOfWindow` | `skipped` folds a stale digest, an empty assembly and a deadline-released claim into one number. `skipped` stays and equals their sum. |
| `standingSeries` | `outOfBudget: 0 \| 1` | The out-of-budget branch currently sets no count at all. |
| `publishing` | `outOfBudget: number` | The deadline `break` currently counts nothing. |
| `webhooks` | `skippedOutOfWindow: number` | Separates the per-item window release from other skips. |
| `engagementRead` | `surfacesUnavailable: 0 \| 1` | Distinguishes "no provider could be read" from "nothing was due". |

## `runTick` options

```ts
export type SectionName = "publishing" | "tokenRefresh" | "generation" | "housekeeping"
  | "webhooks" | "email" | "standingSeries" | "engagementRead" | "engagementSend";

export async function runTick(options?: {
  config?: Partial<SchedulerConfig>;
  /**
   * Run only these sections. Defaults to all nine. For tests that drive hundreds of ticks and care
   * about one section; production never passes it (see docs/decisions.md).
   */
  only?: readonly SectionName[];
}): Promise<TickSummary>;
```

**Guarantees**

- Omitting `only`, or passing all nine names, runs all nine — asserted by a test.
- A section excluded by `only` reports `{ kind: "idle" }` with empty counts and `ok: true`, so the
  summary shape never varies.
- `engagementSend` still waits on `publishing` when both are included; excluding `publishing` does not
  make `engagementSend` wait on nothing it can observe.
- No caller under `src/` passes `only` — asserted by a lint rule.

## Operator log line

`summaryLine()` in `src/server/scheduler/loop.ts` keeps every field it prints today and appends:

```text
Docket scheduler: tick 1840ms published=2 failed=0 … declined=token_refresh:insufficient_time,email:disabled
```

`declined=` is omitted when no section declined. A section that declines on every tick is therefore
visible on every line of the scheduler's own output (FR-023).
