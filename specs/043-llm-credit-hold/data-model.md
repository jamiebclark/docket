# Phase 1 — Data model: credit hold

Everything this entry adds or changes at the database level: two enum values, one install-wide table, five
invariants, one migration, and the exact shape of every statement that is added or changed.

## 1. The two enum additions

`credit_exhausted` is appended — **last** in both arrays, so drizzle generates a plain `ADD VALUE` with no
`BEFORE`/`AFTER` and `pnpm db:check` matches.

```ts
// src/server/db/schema/generation.ts
export const llmFailureKind = pgEnum("llm_failure_kind", [
  "invalid_output", "refused", "incomplete", "timeout",
  "rate_limited", "unavailable", "auth", "bad_request",
  "credit_exhausted",                                     // NEW (FR-028)
]);

// src/server/db/schema/jobs.ts
export const generationJobItemError = pgEnum("generation_job_item_error", [
  "timeout", "rate_limited", "unavailable", "internal", "interrupted",
  "invalid_output", "refused", "incomplete", "auth", "bad_request",
  "image_deleted", "image_unavailable", "no_targets",
  "credit_exhausted",                                     // NEW (FR-028)
]);
```

The same value appears in three more places, none of them a database object:

| Place | Why |
|---|---|
| `src/server/llm/types.ts` — `LlmFailureKind` union **and** `LLM_FAILURE_KINDS` | the array is what `messages.test.ts` walks; both must gain it |
| `src/server/llm/messages.ts` — `LLM_FAILURE_MESSAGES` | the `Record<LlmFailureKind, string>` type forces it |
| `src/lib/validation/generation.ts` — the `failureKind` Zod enum (line 36) | it validates `attempts[].kind` inside a stored `generation_failures.attempts` blob; without it a `credit_exhausted` attempt would fail to parse on read |

**Columns the value can reach, with no column change:**

- `generation_failures.kind` (`llm_failure_kind`) — written by `recordFailure` for an interactive generation
  (US4 AS2);
- `generation_job_items.last_error_kind` (`generation_job_item_error`) — written by the requeue (FR-008);
- `generation_failures.attempts` (`jsonb`) — one `{ kind: "credit_exhausted", latencyMs, usage }` entry.

## 2. The new table

```ts
// src/server/db/schema/generation.ts, beside llmFailureKind
/**
 * System-wide (not project-owned): at most one row per credential owner that is currently refusing on
 * billing. Records that an owner is refusing, never which credential refused — no key, hash or prefix
 * (FR-020, C8). Read and written only through src/server/dal/credit-holds.ts (FR-030).
 */
export const llmCreditHolds = pgTable(
  "llm_credit_holds",
  {
    /** The credential owner (FR-011). Today the single constant "install"; entry 2 adds per-project owners. */
    owner: text("owner").primaryKey(),
    /** When this hold began. Not moved by a later refusal: the screens say "paused since" (FR-022). */
    heldSince: timestamp("held_since", { withTimezone: true }).notNull(),
    /** The most recent billing refusal seen for this owner. */
    lastRefusalAt: timestamp("last_refusal_at", { withTimezone: true }).notNull(),
    /** When one item may go through as a probe. Always now + CREDIT_PROBE_INTERVAL_MS when written (H6). */
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("llm_credit_holds_owner_nonempty", sql`length(${t.owner}) > 0`)],
);
```

```ts
// src/server/db/project-owned.ts
export const notProjectOwned = [
  "user", "session", "account", "verification",
  "install_state", "scheduler_heartbeats",
  "llm_credit_holds",                                     // NEW
] as const;
```

`project-owned.test.ts` requires every table in `src/server/db/schema` to be in exactly one of the two lists,
so this line is mandatory rather than optional. Because the table is not project-owned, the scope harness
(`tests/helpers/scope-check.ts`) ignores statements that touch it — the same treatment `scheduler_heartbeats`
gets — and no `crossProject` wrapper is needed for the service-layer reads.

### Why these columns and no others

| Column | Present because | Deliberately absent |
|---|---|---|
| `owner` | the hold's unit (C7, FR-011); the primary key makes "at most one per owner" a database fact | any key, key hash, key prefix, key id, provider account id or provider name (FR-020, C8) |
| `held_since` | FR-022 needs "paused since" | a refusal counter — one refusal is enough evidence (spec Assumptions) |
| `last_refusal_at` | the operator-visible fact that it is still refusing, and the tick summary's honesty | an `expires_at` — a hold never expires on its own (FR-019, C12) |
| `next_probe_at` | FR-014/FR-015: the probe decision and its single-flight write are the same row | a `probing_tick_id` or lease column — the row lock inside the claim transaction is the whole mechanism (H5) |

A top-up and a swapped key are indistinguishable by design, and both are detected the same way within one
probe interval (C8, US2 AS4).

## 3. Invariants

1. **At most one hold per owner.** The primary key. Two refusals in the same tick (US1 AS3) upsert the same
   row.
2. **`held_since` never moves while a hold lives.** `ON CONFLICT` updates `last_refusal_at` and
   `next_probe_at` only. A fresh hold after a cleared one is a fresh `held_since` (US2 AS6).
3. **`next_probe_at` is always absolute.** Every write sets it to `now + CREDIT_PROBE_INTERVAL_MS` (a grant
   or a refusal) or to `now` (a rewind). Never `next_probe_at + interval` (H6) — so a missed window, a
   backwards clock or a long gap can never queue two probes.
4. **No row is ever created by a rewind or a clear.** `rewindCreditProbe` and `clearCreditHold` are an
   `UPDATE` and a `DELETE`; only `holdCredit` inserts. A hold cleared by a concurrent success cannot be
   resurrected by a late rewind (H7).
5. **An empty table is `main`.** The gate returns `{ held: [], probing: [] }`, `resolveBlockedProjectIds`
   returns `[]`, and `jobsExcludingProjects([])` returns `undefined`, so no predicate is added to the job
   `SELECT` and every owner's budget is the tick's `limit`. The claim statement is byte-identical to today's
   (FR-031, SC-007).

## 4. The migration

One generated file, `drizzle/0021_*.sql`:

```sql
ALTER TYPE "public"."llm_failure_kind" ADD VALUE 'credit_exhausted';--> statement-breakpoint
ALTER TYPE "public"."generation_job_item_error" ADD VALUE 'credit_exhausted';--> statement-breakpoint
CREATE TABLE "llm_credit_holds" (
	"owner" text PRIMARY KEY NOT NULL,
	"held_since" timestamp with time zone NOT NULL,
	"last_refusal_at" timestamp with time zone NOT NULL,
	"next_probe_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_credit_holds_owner_nonempty" CHECK (length("llm_credit_holds"."owner") > 0)
);
```

(Generated with `pnpm db:generate`; the exact text and file name come from drizzle-kit, and `meta/` is
committed with it.)

**Transaction safety.** `ALTER TYPE … ADD VALUE` is allowed inside a transaction block on Postgres 12+ as
long as the new label is not *used* in the same transaction. This migration adds two labels and creates a
table that references neither, so it is safe under drizzle's transactional migrator. Migration `0004`
already ships `ADD VALUE` next to `CREATE TABLE` in this repository, so the combination is proven here.

**Live-install safety (FR-029, C14).** The migration adds, and nothing else:

- no `UPDATE`, so no row is rewritten and no item is reclassified — items failed as `bad_request` or
  `rate_limited` by an earlier outage keep their kind;
- no column is added, dropped or retyped, so no table rewrite and no long lock;
- the new table starts empty, which by invariant 5 reproduces today's behaviour exactly;
- no operator action, no data backfill, no configuration change;
- `ADD VALUE` on an enum is metadata only; it does not touch the tables that use the type.

**Rollback.** There is no down migration (this repository ships forward-only SQL). Reverting the code with
the migration applied is safe: an unused extra enum label and an empty extra table change nothing. Dropping
the table and the labels by hand would also be safe once no row carries the value.

## 5. Statements added

All of these are on `llm_credit_holds` only. `exec` is the database or the claim's transaction handle.

### 5.1 Hold on a billing refusal — `holdCredit(owner, now)`

```sql
INSERT INTO llm_credit_holds (owner, held_since, last_refusal_at, next_probe_at)
VALUES ($owner, $now, $now, $now + interval)
ON CONFLICT (owner) DO UPDATE
   SET last_refusal_at = $now,
       next_probe_at   = $now + interval;
```

Idempotent: the first refusal creates the hold; a refused probe refreshes it and pushes the next probe out
one interval (FR-016). Because the gate had already set `next_probe_at` to `now + interval` when it granted
the probe, and the call takes seconds, this is a refresh rather than an addition — two intervals never stack.

### 5.2 Clear on any other outcome — `clearCreditHold(owner)`

```sql
DELETE FROM llm_credit_holds WHERE owner = $owner;
```

One cheap statement per successful (or non-billing-failed) model call; it touches no row when the table is
empty. Deletion, not a flag, is what makes "no residue from the previous hold" (US2 AS6) structural.

### 5.3 The gate, inside the claim transaction — `gateCreditHolds(exec, now)`

```sql
-- (a) who is held: unlocked, so an owner locked by another tick is still seen (H5)
SELECT owner, next_probe_at FROM llm_credit_holds;

-- (b) of the held owners whose probe is due, which can this tick claim? (skipped = another tick has it)
SELECT owner FROM llm_credit_holds
 WHERE owner = ANY($dueOwners) AND next_probe_at <= $now
   FOR UPDATE SKIP LOCKED;

-- (c) spend the interval for each owner locked by (b), in the same transaction (FR-015)
UPDATE llm_credit_holds SET next_probe_at = $now + interval WHERE owner = ANY($lockedOwners);
```

Returns `{ held: string[], probing: string[] }` where `probing ⊆ held`. (b) and (c) are skipped entirely
when (a) returns no row that is due, so the common no-hold case is one statement against an empty table.

### 5.4 Give the interval back — `rewindCreditProbe(owner, now)`

```sql
UPDATE llm_credit_holds SET next_probe_at = $now WHERE owner = $owner;
```

Update only, so a hold cleared meanwhile is not recreated (invariant 4).

### 5.5 Reads for the screens — `readCreditHold(owner)` / `readCreditHolds()`

```sql
SELECT owner, held_since, last_refusal_at, next_probe_at FROM llm_credit_holds WHERE owner = $owner;
SELECT owner, held_since, last_refusal_at, next_probe_at FROM llm_credit_holds;
```

Plain reads through the same DAL module (FR-030), called by `src/server/services/jobs/read.ts`.

## 6. Statements changed

### 6.1 The job `SELECT` in `claimDueJobItems`

Today:

```ts
.where(and(
  inArray(generationJobs.status, ["queued", "running"]),
  sql`EXISTS (… due item …)`,
))
```

After, with `blocked = held.filter((o) => !probing.includes(o))` resolved to project ids via
`resolveBlockedProjectIds`:

```ts
.where(and(
  inArray(generationJobs.status, ["queued", "running"]),
  sql`EXISTS (… due item …)`,
  jobsExcludingProjects(blockedProjects),   // undefined when blockedProjects is empty → drizzle omits it
))
```

`jobsExcludingProjects` returns `undefined` for an empty set and a `NOT IN` predicate over the resolved
project ids otherwise. Entry 2 only changes what `credentialOwnerFor` answers; `resolveBlockedProjectIds`
keeps working against whatever it returns. With no hold, the emitted SQL is unchanged (invariant 5).

### 6.2 The item `SELECT` in `claimDueJobItems`

The predicate is the same `itemDue` for every job, probing or not (H8):

```ts
const queuedDue = and(eq(generationJobItems.status, "queued"), lte(generationJobItems.nextAttemptAt, now));
const itemDue = or(queuedDue, and(eq(generationJobItems.status, "running"), lte(generationJobItems.leaseUntil, now)));
// per job: always itemDue
```

So a probing owner's one item may be a lease-expired `running` row. US1 AS5 is protected instead by gating
the claim's recovery branch — the `attempt_count` increment and the `interrupted` failure at `maxAttempts` —
on `!probe` (FR-019). For every owner, probing or not, the item predicate is `itemDue`, exactly as today.

### 6.3 The round-robin keep

Today the loop keeps items until `kept.length === opts.limit`. After, it also respects a per-owner budget:

```ts
const budgetFor = (owner: string) => (probing.has(owner) ? 1 : opts.limit);
```

A blocked owner never appears (6.1 removed its jobs). With no hold every owner's budget is `opts.limit`, so
the loop behaves exactly as today.

### 6.4 The item write in `processClaimedItem`

The dispatch at `runner.ts:320` becomes three-way; the new branch is the `commit()` in H11. No other patch
shape changes, and `TEMPORARY` is not touched.

### 6.5 `ClaimedJobItem` and the claim result

```ts
export interface ClaimedJobItem {
  item: JobItemRecord;
  job: JobRecord;
  token: string;
  kind: "run" | "finish";
  recovered: boolean;
  /** The credential owner of this job, from the one named seam (FR-012). */
  owner: string;                      // NEW
  /** This item is the one a held owner was allowed through as a probe (FR-014). */
  probe: boolean;                     // NEW
}

export interface ClaimResult {        // NEW: claimDueJobItems' return (H9)
  items: ClaimedJobItem[];
  /** Owners with a hold at claim time. */
  held: string[];
  /** The subset granted this tick's probe; `probing ⊆ held`. */
  probing: string[];
}
```

### 6.6 `GenerationCounts`

```ts
  /** Items a billing refusal sent back to the queue with no attempt counted (FR-009). */
  requeued: number;                   // NEW
  /** At least one credential owner was held, so its items were not claimed (FR-021). */
  held: 0 | 1;                        // NEW
  /** A held owner was allowed one item through as a probe this tick (FR-021). */
  probed: 0 | 1;                      // NEW
```

Added to `emptyGenerationCounts()` as `0`. They reach the heartbeat for free, because
`writeHeartbeat("generation", …, { ...counts })` spreads the whole object — the same route the existing
`notConfigured` and `notRunnable` flags take (FR-021).

## 7. What is not touched

- `generation_job_status` and `generation_job_item_status`: no new status, no changed status (FR-025, C13).
- `deriveJobStatus` and `refreshJobStatus`: unchanged. `queued + running` is invariant across a requeue, so
  no job's derived status can move because of a billing outage (FR-008).
- `generation_jobs`, `generation_job_items`, `generation_failures`, `media_assets` and every other
  project-owned table: no column added, dropped or retyped. Reserved images stay reserved because a
  reservation is an item in `queued`/`running`/`failed` and a requeued item is `queued` (FR-019).
- `projectOwnedTables` and the project-scope rules: untouched (FR-030).
- The public API's schemas: `JobItemSchema.error` is already `{ kind: z.string(), message: z.string() } |
  null`, and every API mapper lists its fields explicitly, so no payload changes (US4 AS4, SC-007).
- `maxAttempts`, the backoff curve, the 500-item limit, the tick budget rules and
  `GENERATION_TICK_MAX_ITEMS`: unchanged.
