# Contract: services, DAL and harness

These are the internal interfaces that implementation codes against. Every caller (screens, API, scheduler) goes through these. Nothing else reads or writes `activity_events` (constitution IV).

## 1. DAL — `src/server/dal/activity.ts`

```ts
export interface NewActivityEvent {
  kind: ActivityKind;                    // outcome is derived from KIND_OUTCOME, never passed
  occurredAt: Date;                      // whole ms; the caller's clock.now()
  postId?: string | null; postTargetId?: string | null;
  socialAccountId?: string | null;
  providerKey: string | null;            // null only for group connect failures
  providerKeys?: readonly string[];      // default [providerKey]
  groupKey?: string | null;
  actorUserId?: string | null; actorApiKeyId?: string | null;
  message: string;                       // clipped by insert (clipMessage) — callers pass scrubbed text
  details: ActivityDetails;              // parsed with the strict union for `kind`
}

/** Append-only: insert, list, summary. No update or delete (FR-008). */
export interface ActivityRepo {
  insert(event: NewActivityEvent): Promise<{ id: string }>;
  list(q: BranchQuery & { cursor: ActivityCursor | null; direction: "older" | "newer"; limit: number }): Promise<ActivityRecord[]>;
  summary(q: BranchQuery): Promise<{ successes: number; problems: number }>;
}

/** One project's slice of a query: its id, its own [from, to) window and the shared filters. */
export interface BranchQuery {
  windows: { projectId: string; from: Date | null; to: Date | null }[];   // one entry for a project scope
  outcomes: readonly ActivityOutcome[] | null;
  platform: string | null;
  accountId: string | null;
}

export function createActivityRepo(db: Database, projectId: string): ActivityRepo;
```

- `createActivityRepo` is added to `createSchedulingRepos` as `activity`. That makes `scope.activity`, `forSchedulerProject(id).activity` and transaction handles all have it. A single-project repo rejects any window whose `projectId` is not its own, so it throws before any SQL runs.
- `ActivityRecord` is the event row plus its joined read columns. It is the raw input to §3's views:
  - `projectSlug`, `projectName`, `projectTimeZone`;
  - `accountName`, `accountRemovedAt`;
  - `postDeletedAt`, `postText` (`override_text ?? base_text`);
  - `targetStatus`.
- The SQL shape is one branch per window, combined with `UNION ALL`. Each branch:
  - is pinned by `"activity_events"."project_id" = $k`;
  - joins `projects`, `posts`, `post_targets` and `social_accounts` on `project_id` equality plus id;
  - applies the time window, the `(occurred_at, seq)` cursor predicate, `outcome = ANY`, `provider_keys @> ARRAY[$p]` and `social_account_id = $a`;
  - uses `ORDER BY occurred_at DESC, seq DESC LIMIT $limit+1`, or ASC for `newer`.

  The outer query orders and limits again. `summary` returns one row per branch, which the repo sums.
- `src/server/dal/scheduler.ts`:
  - `ClaimDecision` gains `activity?: NewActivityEvent`;
  - `claimDueTargets` inserts it with `createActivityRepo(exec, row.projectId)` right after the attempts, in the claim transaction.

## 2. DAL — `src/server/dal/my-projects.ts` (all-projects)

```ts
export interface MyProject { id: string; slug: string; name: string; timeZone: string; role: Role }

export interface ProjectSetScope {
  readonly userId: string;
  readonly projects: readonly MyProject[];          // current memberships whose role can post:view, by name
  readonly activity: Pick<ActivityRepo, "list" | "summary">;  // every window must name one of `projects`
  /** Batched name lookups for actor labels, each pinned to one project. */
  memberNames(projectId: string): Promise<Map<string, string>>;
  apiKeyName(projectId: string, keyId: string): Promise<string | null>;
}

/** Resolves on every call (never cached). No session → NotFoundError. No projects → an empty set (not an error). */
export function forMyProjects(session: SessionLike | null): Promise<ProjectSetScope>;
```

- The membership read runs in `crossProject("resolve my projects")`.
- Every `activity` statement runs inside `runForProjectSet({ reason: "activity: my projects", projectIds }, …)`. Each branch also joins `member` on `member.organization_id = activity_events.project_id AND member.user_id = $u` (research P11).
- It is exported from `src/server/dal/index.ts`. It is the only new cross-project surface.

## 3. Services — `src/server/services/activity/`

| Module | Exports |
|---|---|
| `classify.ts` (pure) | `eventForStep({ outcome, attemptCount, error, now, target, account })`, `eventForDecision({ decision, target, account, now })`, `resolvedEvent({ action, target, providerKey, actor, now, url?, scheduledAt?, mode?, requeue? })`, `needsReauthEvent({ account, reason, message, now })`, `connectFailedEvent({ via, code, message, providerKeys, providerKey?, groupKey?, accountId?, actor, now, secrets })` |
| `record.ts` | `recordTargetEvent(tx, event)`, `recordAccountNeedsReauth(tx, accountId, reason)`, `recordConnectFailed(scope, event)`. These are thin wrappers that call `tx.activity.insert` and return nothing on a `null` event. |
| `filters.ts` (pure) | `parseActivityFilter(raw, { mode, allowProjects })` → `{ filter, issues }`, `windowFor(filter, timeZone, now)` → `{ from, to }`, `summaryLabel(filter)`, `filterToSearchParams(filter)` (the canonical URL, used by every link). |
| `cursor.ts` (pure) | `encodeActivityCursor({ t, s, d })`, `decodeActivityCursor(s)` → value \| `null` |
| `links.ts` (pure) | `activityLink(row, projectSlug)` (research P15) |
| `index.ts` | `listProjectActivity(scope, raw, opts)`, `listMyActivity(projectSet, raw, opts)`, `listActivityForApi(scope, query)` |

```ts
export interface ActivityPage {
  rows: ActivityRow[];                 // data-model §4
  summary: ActivitySummary;
  filter: ActivityFilter;
  invalidRange: boolean;               // from > to: rows = [], summary zeros, inline message
  newer: string | null;                // cursor for the "Newer" link
  older: string | null;                // cursor for the "Older" link
  accounts: { id: string; name: string; providerKey: string }[];   // filter options (project view only)
  platforms: { key: string; name: string }[];
  projects?: { slug: string; name: string }[];                     // all-projects only
}

/** Throws ForbiddenError without post:view. Lenient filter; malformed cursor → first page. */
export function listProjectActivity(scope: ProjectScope, raw: Record<string, string | string[] | undefined>): Promise<ActivityPage>;
/** Same rows, filters and counts across the caller's current projects; a slug filter outside them matches nothing. */
export function listMyActivity(set: ProjectSetScope, raw: Record<string, string | string[] | undefined>): Promise<ActivityPage>;
/** Strict filter (issues → ValidationError with details); older-only cursor; `limit` 1–100. */
export function listActivityForApi(scope: ProjectScope, query: ApiActivityQuery): Promise<{ data: ActivityRow[]; nextCursor: string | null }>;
```

`now` comes from `clock.now()` (tests use `atTime`). The page size is 50 on screens.

## 4. Changed call sites (each in the transaction it already holds)

| File | Change |
|---|---|
| `src/server/scheduler/record.ts` | `RecordInput` gains `socialAccountId`, `providerKey` and `postId`. When `applied`, it inserts `eventForStep(...)`. |
| `src/server/scheduler/publishing.ts` | `decide()` attaches `activity: eventForDecision(...)` to the settled, failed and recovered-retry decisions. `execute()` passes the account to `recordStepResult`. |
| `src/server/scheduler/credentials.ts` | When the existing emit rule holds (`changed && previousStatus === "active"`), both helpers also call `recordAccountNeedsReauth(tx, id, reason)`. `recordRefreshEmitting` gives the reason `renewal_refused`, and `markInvalidEmitting` gives `credentials_invalid`. |
| `src/server/services/posts/retry.ts` | `retryLockedTarget(tx, target, now, input, opts?: { via?: "bulk" })` inserts `resolvedEvent` after each successful update. It does not insert one on no-free-slot. |
| `src/server/services/posts/retry-all.ts` | `retryOne` passes `{ via: "bulk" }`. |
| `src/server/services/posts/index.ts` | The four `resolveAmbiguous` branches each insert `resolvedEvent` after their guarded update succeeds. |
| `src/server/services/connect.ts` | `handleOAuthCallback`'s `finish` writes the event and `complete` in one `scope.transaction` for the D4 codes. `pasteConnectToken` records its four refusals. Both use `connectBannerText` (§5). |
| `src/server/services/accounts.ts` | `connectWithCredentials` records `credentials_refused` (redacted `result.message`), `credentials_unreachable` (the thrown or timeout case) and `different_account`. It does not record `fieldErrors` validation. |
| `src/server/services/failures.ts` | `failuresQuerySchema.target`. `listAttention({ targetId })` lives in `src/server/dal/targets.ts`. |

## 5. Shared pure libs — `src/lib/`

- `activity/outcomes.ts`: the tables in data-model §2.
- `activity/details.ts`: `activityDetailsSchema(kind)`, the strict union from data-model §3.
- `activity/text.ts`:
  - `clipMessage(s, 500)`;
  - `resolvedMessage(details)`;
  - `activityActorLabel(actor)`, which gives "Scheduler", the member's name, "Former member", "API key {name}" or "Removed API key";
  - `outcomeLabel(o)`.
- `accounts/connect-banner-text.ts`: `CONNECT_BANNER`, `HINTED_CODES`, and `connectBannerText({ code, own, hint })`. The accounts page imports these in place of its local constants, and its behaviour is unchanged.

## 6. Scope harness — `src/server/db/cross-project.ts`, `src/server/db/client.ts`, `tests/helpers/scope-check.ts`

```ts
export function runForProjectSet<T>(set: { reason: string; projectIds: readonly string[] }, fn: () => Promise<T>): Promise<T>;
export function currentProjectSet(): { reason: string; projectIds: readonly string[] } | undefined;
```

- The query logger adds `projectSet` to `ObservedQuery`. `tests/setup/scope-recorder.ts` copies it into `QueryRecord`.
- `checkScope(records, owned)` handles a record with `projectSet` in two steps:
  1. It applies the ordinary pin rules. Every reference to a project-owned table in every query scope must be pinned.
  2. For every `scopeColumn = $n` pin found, `params[n-1]` must be in `projectSet.projectIds`. Otherwise the violation is `Project-set query pinned to a project outside the caller's set ("<reason>")`.
- The summary line also counts project-set reasons.
- A record without `projectSet` is checked exactly as today. `crossProject` records are skipped as today.
