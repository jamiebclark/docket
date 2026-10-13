# Contract: recording and reporting

**Feature**: `068-llm-cost-visibility` | Covers **FR-001** – **FR-008**, **FR-014** – **FR-019**,
**FR-028**, **FR-029**.

---

## 1. `src/server/dal/llm-usage.ts` — the repository

```ts
export interface LlmUsageLink {
  postId?: string | null;
  seriesId?: string | null;
  seriesPosition?: number | null;
  generationJobId?: string | null;
  generationJobItemId?: string | null;
}

export interface LlmUsageInsert extends LlmUsageLink {
  purpose: UsagePurpose;
  provider: LlmProviderName;
  model: string;
  credentialSource: "project" | "install";
  ok: boolean;
  failureKind: LlmFailureKind | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  calledAt: Date;
}

/** Half-open [from, to); a null bound is open, so "all time" is { from: null, to: null }. */
export interface UsageWindow { from: Date | null; to: Date | null }

/** The DAL owns the aggregate shapes; the service layers rates on top (it never reshapes them). */
export interface UsageTotals { /* see § 4 */ }
export interface ModelTotals extends UsageTotals { provider: LlmProviderName; model: string }
export interface PurposeTotals { purpose: UsagePurpose; calls: number; inputTokens: number; outputTokens: number }

export interface LlmUsageRepo {
  /** Insert-only. One statement for the batch. No update, no delete — by design (FR-007). */
  record(rows: readonly LlmUsageInsert[]): Promise<void>;

  /** Aggregates for one window. */
  summary(window: UsageWindow): Promise<UsageTotals>;
  byModel(window: UsageWindow): Promise<ModelTotals[]>;
  byPurpose(window: UsageWindow): Promise<PurposeTotals[]>;

  /** The job page (FR-028). One indexed aggregate, no join. */
  totalsForJob(jobId: string): Promise<UsageTotals>;
}

export function createLlmUsageRepo(exec: Database, projectId: string): LlmUsageRepo;
/** For `runLlmCheck`, which is given a project id and no scope — same seam as `projectLlmRepoFor`. */
export function llmUsageRepoFor(projectId: string): LlmUsageRepo;
```

Wired as `scope.llmUsage` in `buildScope` (`src/server/dal/scope.ts`), and
`llm_call_usage` is added to `src/server/db/project-owned.ts`. Every statement filters
`project_id = $1`, so `tests/integration/scope-check.test.ts` covers the table from its first query
(**FR-008**).

`record` is the **only** write path and takes no transaction handle: it must never join a caller's
transaction (**M6**, **FR-005**).

## 2. `src/server/llm/usage.ts` — the recorder

```ts
export type UsagePurpose =
  | "generate.single" | "generate.series_plan" | "generate.series_post"
  | "generate.regenerate" | "generate.job_item" | "voice.try" | "llm.check";

export interface UsageRecorder {
  /** The provider, with recording. Delegates `generate`, returns its result unchanged. */
  wrap(llm: LlmProvider): LlmProvider;
  /** Writes every call observed so far with `link`, then forgets them. Never throws, never rejects. */
  flush(link?: LlmUsageLink): Promise<void>;
}

export function createUsageRecorder(args: {
  projectId: string;
  purpose: UsagePurpose;
  source: "project" | "install";
  repo?: LlmUsageRepo;   // defaults to llmUsageRepoFor(projectId)
}): UsageRecorder;
```

**`wrap`** mirrors `withCreditHold` exactly (`src/server/services/generation/credit.ts`):

```
const result = await llm.generate(request);
buffer.push({ provider: result.provider, model: result.model,
              ok: result.ok, failureKind: result.ok ? null : result.kind,
              inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
              latencyMs: Math.round(result.latencyMs), calledAt: await clock.now() });
return result;                       // unchanged, always
```

Guarantees, each with a test behind it:

| Guarantee | Requirement |
|---|---|
| `generate`'s return value is never altered, delayed beyond its own buffering, or replaced | **FR-005**, **SC-009** |
| `flush` catches everything and logs one redacted line with no prompt, output or credential | **FR-005**, **US5 scenario 2** |
| `flush` is a no-op when the buffer is empty — a call that never happened writes nothing | **M5**, **FR-006** |
| `flush` clears the buffer, so a second flush writes nothing twice | **SC-001** |
| only calls **this** recorder observed are written — a resumed job item's earlier call is not re-recorded | **P1**, spec edge case "deferred correction retry" |
| `calledAt` comes from `clock.now()`, so `runAtTime` pins it in tests | existing house clock |
| no row carries a prompt, output, error text or key | **FR-004**, **M7** |

`purpose` is a required argument and is **not** read from `request.label` (**P5**). A guard test
scans `src/` for `label:` literals reaching `llm.generate` and fails if any has no matching
`UsagePurpose`.

## 3. Wiring, per call site

Each site resolves its credential already; `source` comes from the same `ResolvedLlm` that supplies
`owner` to `withCreditHold`. Where a site accepts an injected `llm` (tests, the runner), the
recorder wraps that provider and `source` is the resolved one (`install` under
`setLlmForTests`, matching `resolveLlmForProject`'s own test override).

| Site | Wrap point | `flush(link)` |
|---|---|---|
| `generation/core.ts` `runGeneration` | beside the existing `resolveLlmForProject` / `withCreditHold`, recorder returned to the caller | caller's |
| `generation/core.ts` `runGenerationStep` | wraps the `llm` it is handed, when a recorder is passed in `StepOptions` | caller's |
| `single.ts` `generateSingle` | via `runGeneration` | after the save transaction: `{ postId }`; on failure or a dedup collision: `{}` (**P4**) |
| `series.ts` `planSeries` | its own recorder beside `withCreditHold` | `{}` immediately (**P3**) |
| `series.ts` `writeSeriesPost` | via `runGeneration` | after the save: `{ seriesId, seriesPosition, postId }`; on failure: `{ seriesId, seriesPosition }` |
| `regenerate.ts` | via `runGeneration` | `{ postId }` — known before the call |
| `jobs/runner.ts` | `StepOptions.recorder`, beside the existing `owner` | `{ generationJobId, generationJobItemId }`, after the item is finished — on **every** exit of the step: deferred, failed, requeued, cancelled, stale or saved |
| `voice.ts` `tryVoice` | via `runGeneration` | `{}` |
| `generation/check.ts` `runLlmCheck` | beside its `withCreditHold(resolved.llm, resolved.owner)` | `{}` in the same `finally` that releases the check lease |

**The runner's every-exit rule matters.** A deferred step, a credit requeue, a `fail`, a cancelled
job and a stale lease all return early after the model was called, and each path's tokens were
spent. The flush is placed so that it runs whenever `calledModel` became true — the same flag the
runner already keeps.

**Nothing is wrapped when no call is made.** Resolution failing (`not_configured`,
`key_unreadable`), the credit hold refusing before the call, the 16-group limit, generation
switched off: the recorder is either never created or flushed empty, and writes nothing
(**M5**, **FR-006**, **SC-002**).

## 4. `src/server/services/usage.ts` — the report

```ts
export type UsagePeriod = "30d" | "month" | "last-month" | "all";
export const USAGE_PERIODS: readonly UsagePeriod[];     // order shown on screen
export const DEFAULT_USAGE_PERIOD: UsagePeriod = "30d"; // FR-016

/** The one sentence that carries every money figure (FR-020, SC-005). Exported so a test can assert it. */
export const ESTIMATE_DISCLAIMER: string;

/** Declared in the DAL (§ 1) and re-exported here; spelled out once, for readability. */
export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  callsWithoutCounts: number;        // FR-017
  failedCalls: number;               // FR-018
  failedInputTokens: number;
  failedOutputTokens: number;
  projectCredentialCalls: number;    // FR-015
  installCredentialCalls: number;
}

export interface ModelUsageRow extends ModelTotals {
  /** Present only when a rate matched; absent (not zero) otherwise (FR-021). */
  estimateMicros?: number;
  /** True when the matched rate is 0 — a configured zero, not a missing one (M11, FR-012). */
  rateIsZero?: boolean;
}

export interface UsageView {
  period: UsagePeriod;
  /** Resolved in the project's zone; `null` bounds mean open (M17, SC-013). */
  window: { from: Date | null; to: Date | null };
  timeZone: string;
  totals: UsageTotals;
  byModel: ModelUsageRow[];
  byPurpose: PurposeTotals[];
  /** Absent when no rate at all is configured — the money column does not exist (M14, FR-023). */
  money?: {
    currency: string;
    /** Over priced models only; always carried by ESTIMATE_DISCLAIMER (FR-019, FR-022). */
    totalMicros: number;
    pricedModels: number;
    /** Named in the total, with their counts (FR-022, SC-004). */
    excluded: { provider: string; model: string; calls: number; tokens: number }[];
    /** True when rates exist but nothing in this period matched one (FR-024, US3 scenario 3). */
    noPricedUsage: boolean;
  };
}

/** Owner and admin only, on the existing permission. Throws ForbiddenError otherwise (FR-026). */
export function getProjectUsage(scope: ProjectScope, period: UsagePeriod): Promise<UsageView>;

/** Calls and tokens for one job, for the job page. No money (P19). */
export function getJobUsage(scope: ProjectScope, jobId: string): Promise<UsageTotals>;
```

`getProjectUsage` opens with `requirePermission(scope, { llm_credential: ["manage"] })` — the
existing statement from entry 2, reused verbatim. **No new permission, no new role, no new
`access.ts` entry** (**M15**, **FR-026**).

### Period windows (M17, SC-013)

`usagePeriodWindow(period, timeZone, now)` in `src/lib/generation/usage-period.ts`, pure and unit
tested:

| Period | `from` | `to` |
|---|---|---|
| `30d` | midnight 29 days before today, project zone | midnight after today |
| `month` | midnight on the 1st of this month | midnight after today |
| `last-month` | midnight on the 1st of last month | midnight on the 1st of this month |
| `all` | `null` | `null` |

Every boundary is
`date.toPlainDateTime().toZonedDateTime(timeZone, { disambiguation: "compatible" })` — explicit, as
the constitution requires, because `PlainDate.toZonedDateTime` takes no such option (**P13**). The
window is half-open `[from, to)` so no call is counted in two periods.

### The money rules, restated as code-level invariants

1. `money` is **absent** when `getLlmRates().entries.length === 0` (**FR-023**).
2. `ModelUsageRow.estimateMicros` is **absent** when no rate matched that exact
   `(provider, model)` (**FR-021**).
3. `money.totalMicros` sums only rows that have `estimateMicros`, and `money.excluded` lists every
   row that does not, with its calls and tokens (**FR-022**, **SC-004**).
4. `money.noPricedUsage` is true when `pricedModels === 0` and the period has usage — the screen
   then shows **no total**, not zero (**FR-024**).
5. Null token counts are excluded from every sum, and `callsWithoutCounts` reports them
   (**M3**, **FR-017**, **SC-006**).
6. Nothing in `UsageView` is cached across requests: the rates are read per render, so a corrected
   rate changes a past period on the next load (**M10**, **FR-025**, **SC-007**).

## 5. What is **not** added

No public API route, no API schema, no webhook event, no notification, no email, no activity event,
no export, no CLI command, no cross-project or install-wide report (**M16**, and the spec's
out-of-scope list). The only new reachable surface is the Usage page in
[contracts/ui.md](./ui.md).
