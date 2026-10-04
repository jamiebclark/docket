# Contract: services and engine changes

Every signature below is TypeScript in the existing style. `scope` is a `ProjectScope` and every function checks `scope.can()` itself (constitution III and IV). Errors are the existing DAL errors (`NotFoundError`, `ForbiddenError`, `ConflictError`, `ValidationIssuesError`) and `ZodError` for bad input. `runAction` maps all of them to an `ActionResult`.

## 1. `src/server/services/failures.ts` (new, read-only)

```ts
export const FAILURES_PAGE_SIZE = 25;

export const failuresQuerySchema: z.ZodType<{ status: "all" | "ambiguous" | "failed"; account?: string; page: number }>;

export interface FailureActions {
  canMarkPublished: boolean;      // ambiguous && scope.can(post:schedule)
  canRequeue: boolean;            // ambiguous && can && account active && provider registered
  canMarkNotPublished: boolean;   // ambiguous && can (allowed for a removed account: it records what happened)
  canRetry: boolean;              // failed && can && retryBlockedReason === null
  retryBlockedReason: string | null; // the same text retryTarget throws (shared helper)
}

export interface FailureRow {
  targetId: string;
  postId: string;
  status: "ambiguous" | "failed";
  account: { id: string; name: string; providerName: string; status: "active" | "needs_reauth" | "removed" };
  excerpt: string;
  intendedAt: Date | null;
  intendedLocal: string | null;   // "2026-10-09T09:00 Europe/London"
  scheduleKind: "slot" | "explicit" | "now" | null;
  lastError: string | null;
  attemptCount: number;
  enteredAt: Date;
  actions: FailureActions;
  attempts: AttemptRun[];
}

export interface FailureList {
  rows: FailureRow[];
  totals: { ambiguous: number; failed: number }; // across the whole project, ignoring filters
  filtered: number;                               // total rows for the current filter
  page: number;
  pageSize: number;
  accounts: { id: string; name: string }[];       // for the account filter
}

/** FR-001–FR-004, FR-006. Requires post:view. One query for rows, one for their attempts, one for actor names. */
export function listFailures(scope: ProjectScope, input?: unknown): Promise<FailureList>;

/** FR-005. Requires post:view (0 otherwise, matching countReviewQueue). One count(*) on the partial index. */
export function countNeedsDecision(scope: ProjectScope): Promise<number>;

/** FR-008 dialog preview. Requires post:schedule. No writes. */
export function previewRequeue(scope: ProjectScope, targetId: string): Promise<RequeuePreview>;
```

`AttemptRun`, `AttemptEntryView` and `RequeuePreview` are defined in [data-model.md](../data-model.md) §3. `groupAttemptRuns(entries)` is a pure, exported helper with unit tests.

### DAL additions (scoped, inside `src/server/dal/`)

```ts
// targets.ts
listAttention(opts: { statuses: ("ambiguous" | "failed")[]; accountId?: string; limit: number; offset: number }):
  Promise<{ rows: (TargetRecord & { baseText: string })[]; total: number }>;  // joins live posts only
countAttention(): Promise<{ ambiguous: number; failed: number }>;

// attempts.ts
listForTargets(postTargetIds: readonly string[]): Promise<AttemptRow[]>; // created_at, id order

// users or members: a batched name lookup for actor ids (existing members repo if it has one; else a scoped read)
```

All three are project-scoped (`project_id = $projectId`). The scope-check test covers them automatically.

## 2. `src/server/services/posts/index.ts` (changed)

```ts
const resolveSchema = z.union([
  z.object({ outcome: z.literal("published"), url: externalUrlSchema.optional() }),
  z.object({ outcome: z.literal("not_published"), requeue: z.literal(true), expected: z.iso.datetime().optional() }),
  z.object({ outcome: z.literal("not_published"), requeue: z.literal(false) }),
  z.object({ outcome: z.literal("failed") }).transform(() => ({ outcome: "not_published" as const, requeue: false as const })),
]);

export type ResolveResult =
  | { status: "published" }
  | { status: "scheduled"; scheduledAt: string; localTime: string; slotId: string; changedFromPreview: boolean }
  | { status: "failed"; reason: "not_requeued" | "no_free_slot"; message: string };

/** FR-007, FR-008, FR-010. Requires post:schedule. Transitions in data-model.md §2. */
export function resolveAmbiguous(scope: ProjectScope, targetId: string, input: unknown): Promise<ResolveResult>;

/** FR-009. Unchanged semantics; refusals now come from retryBlockedReason; loser message changed. */
export function retryTarget(scope: ProjectScope, targetId: string): Promise<void>;

/** Pure: null when retry is allowed; otherwise the user-facing reason (D8). Shared by retryTarget and the views. */
export function retryBlockedReason(account: AccountRecord | null, providerRegistered: boolean): string | null;
```

The requeue path calls `allocateNextFree` (`services/queue`). That is the only allocator. It never calls `queueTargetsInTx`, whose `queueableGate` correctly refuses non-draft targets.

`getPostView` (`services/posts/view.ts`) adds `attemptCount`, `actions` and actor-resolved attempts to each `PostViewTarget`. It uses the same `listForTargets` and grouping helpers as the failures view.

## 3. Validation path (`src/server/services/posts/validate.ts`, changed)

```ts
/** Provider validation of already-resolved content. The single core of every content check (constitution IV). */
export function validateResolvedContent(provider: SocialProvider, content: PostContent): ValidationIssue[];

// validateTargetContent keeps its signature and calls validateResolvedContent internally.
```

## 4. Publish engine (`src/server/scheduler/publishing.ts`, changed)

- **Publish-time validation (FR-015, research D11).**
  - When: on the first step (`target.stepState === null`), after `resolvePublishMedia` succeeds and before any credentials are read.
  - Check: `validateResolvedContent(provider, content)`.
  - On an error-severity issue: `result = { kind: "fatal_error", error: \`Can't publish to ${provider.displayName}: ${firstError.message}\` }`, and the step is recorded as `engine-validate`.
  - No provider call is made.
- **Pre-call failures (FR-012, research D22).**
  - A local `providerCalled` is set to `true` immediately before `provider.advance(...)`.
  - In the `catch`, when `!providerCalled`:
    - `CredentialsUnreadable` (wrapping a `decryptCredentials` throw) → `fatal_error`, "The account's stored credentials can't be read. Reconnect <name>.";
    - a `settingsSchema.parse` throw → `fatal_error`, "The account settings are invalid.";
    - anything else → `retryable_error`, "Publishing could not start; will retry.".
  - When `providerCalled` is true, today's rule is unchanged: `mayPublish` → ambiguous.
- **Publish limits (G14, research D12):**

  ```ts
  // src/providers/types.ts
  defaultPublishLimit?: PublishLimit | readonly PublishLimit[];
  // src/providers/limits.ts (new)
  export function providerPublishLimits(provider: Pick<SocialProvider, "defaultPublishLimit">): PublishLimit[];
  // src/server/scheduler/limits.ts
  export function effectiveLimits(providerDefaults: readonly PublishLimit[], account: AccountLimitFields): PublishLimit[];
  ```

  - `services/accounts.ts` `setPublishLimit` warns when the account limit is looser than **any** provider default with the same or a shorter window.
  - Bluesky declares `[{ count: 1666, windowSeconds: 3600 }, { count: 11666, windowSeconds: 86400 }]`, with a comment citing `docs/research/bluesky.md` (approximate).

## 5. Webhooks (`src/server/services/webhooks/`, changed)

- `deliver.ts` `sendDelivery` calls `postGuarded(endpoint.url, …)` from `src/server/net/safe-fetch.ts` with policy `"webhook"`. The outcome mapping (status, `redirect`, `timeout`, …) is unchanged. A refused address maps to a new `errorKind: "address_not_allowed"`. That value is added to the `webhook_attempt_error` enum in migration 0007 (data-model §1).
- `endpoints.ts` `createEndpoint` and `updateEndpoint` run `checkWebhookDestination(url)` after schema validation. It does one DNS resolution with a 3 s timeout. A refused address throws a `ValidationIssuesError` on field `url`: "That address points at this server or a reserved network and can't receive webhooks." A failed resolution returns `{ warning: "We couldn't look up that host now; deliveries will check it each time." }`.
- `setWebhookDeliveryOverridesForTests({ addressPolicy?, timeoutMs? })` mirrors `setUrlFetchOverridesForTests`.

## 6. `src/server/net/safe-fetch.ts` (changed)

```ts
export type AddressPolicy = "public" | "webhook" | "allow-loopback";
export function isAllowedAddress(address: string, policy?: AddressPolicy): boolean; // + 6to4, Teredo, doc, ::/96, mapped-IPv4 extraction
export function postGuarded(url: string, opts: {
  body: string; headers: Record<string, string>; timeoutMs: number; policy: AddressPolicy; maxResponseBytes: number;
}): Promise<{ status: number; headers: Headers; bodyExcerpt: Buffer }>; // never follows redirects; lookup-guarded per connection
```

## 7. Audit (`src/server/dal/audit.ts`, changed)

`createAuditRepo().insert` calls `assertSafeDetails(entry.details)` before inserting. It throws `Error("Audit details must not carry secrets: <key>")` for keys matching `/token|url|password|secret/i`. `services/audit.ts` `recordAudit` delegates to it. The invitations service needs no code change.

## 8. Configuration (`src/server/startup/validate.ts`, new)

```ts
export interface ConfigurationResult {
  ok: boolean;
  issues: EnvIssue[];        // every problem, names and reasons only
  disabled: string[];        // "media storage", "generation", "Facebook Pages and Instagram", "Threads", "HTTP tick trigger", "mock provider"
  env?: Env;                 // when ok
}
export function validateConfiguration(source: Record<string, string | undefined>): ConfigurationResult;
export function formatDisabled(disabled: string[]): string[]; // one "Docket: <feature> not configured" line each
```

- **Callers:**
  - `runStartup` replaces its own `parseEnv` + `providerEnvIssues` + LLM log;
  - `src/worker.ts`;
  - `scripts/prestart.mjs`, **before** `migrationUrl`.
- **On failure:** each caller prints `formatEnvIssues(issues)` and exits 1.
- **Order:** prestart validates before migrating, so the web process's own validation (re-run in `register()`) always sees an already-validated environment.
- `src/server/llm/config.ts` adds `llmEnvIssues(source): { issues: EnvIssue[]; disabled: boolean }` and `LLM_VARIABLES`. `parseLlmConfig` keeps its signature for callers that build clients.
- `src/server/env.ts` adds `NODE_ENV`, `PORT` and `HOSTNAME` to the schema and exports `ENV_VARIABLES` and `directUrlOf(source)` (`source.DATABASE_URL_DIRECT || source.DATABASE_URL`).
- `src/server/config-registry.ts` (new) exports `INTERNAL_VARIABLES: Record<string, string>` (name → reason) and `COMPOSE_ONLY_VARIABLES: readonly string[]`.

## 9. Smoke script (`scripts/smoke.ts`, new; bundled to `.next/standalone/scripts/smoke.mjs`)

It is driven by services and HTTP, as described in research D29. It runs only when invoked by hand, never at import.

- **Exit codes:** 0 on success, 1 on the first failed step.
- **Output:** one line per step: `✓ step — detail` or `✗ step — reason`. No secret values are printed.
