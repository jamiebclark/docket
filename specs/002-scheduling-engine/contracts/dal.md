# Contract: DAL additions (developer-facing)

This extends `specs/001-foundation-auth-projects/contracts/dal.md`. All rules
there still hold:

- only `src/server/{dal,db,auth,startup}/**` import the database client;
- every query on a project-owned table is pinned by `project_id = $n`, or runs inside `crossProject(reason)`;
- roles are checked on the server.

## New modules (`src/server/dal/`)

| Module | Exports | Notes |
|---|---|---|
| `clock.ts` | `now(): Promise<Date>`; `runAtTime(date, fn)` (ALS override, D1) | production: `select clock_timestamp()`; tests import `atTime` from `tests/helpers/clock.ts`, which wraps `runAtTime` |
| `accounts.ts` | `createAccountsRepo(db, projectId)` | `list`, `get`, `getForUpdate`, `upsertConnected`, `updateSettings`, `setLimit`, `markRemoved`, `getCredentialsCiphertext` (internal; used only by the scheduler and refresh) |
| `slots.ts` | `createSlotsRepo(db, projectId)` | `listForAccount`, `listActiveForAccount`, `insert` (maps `23505` → `ConflictError`), `setPaused`, `delete` |
| `media.ts` | `createMediaRepo(db, projectId)` | `insert`, `get`, `getMany(ids)`, `markUsed(ids, now)`, `updateAlt` |
| `posts.ts` | `createPostsRepo(db, projectId)` | `insert`, `get` (excludes `deleted_at`), `lockForUpdate(postId)` (its own statement, D11), `update`, `setMedia(postId, ids)`, `setStatus`, `softDelete` |
| `targets.ts` | `createTargetsRepo(db, projectId)` | `listForPost`, `get`, `insertMany`, `update(id, patch, guard?)`, `heldInstants(accountId, from, to)`, `tryHoldOccurrence(targetId, instant, slotId)` (savepoint; `false` on `23505`), `releaseOccurrence`, `queuedForAccount(accountId, after)` (locks in order), `nearScheduled(accountId, instant, windowMs)`, `effectiveContent(targetId)` |
| `attempts.ts` | `createAttemptsRepo(db, projectId)` | **`insert` and `listForTarget` only** (FR-006) |
| `scheduler.ts` | `claimDueTargets(opts)`, `claimRefreshAccounts(opts)` (both inside `crossProject` with the reasons in contracts/scheduler.md); `forSchedulerProject(projectId)` → `{ accounts, posts, targets, attempts, media, transaction }` pinned to one project with **no membership** (FR-008: "act on each target within that target's project"); `releaseLease`, `recordWithLease(targetId, token, patch)` → `boolean` | the only DAL surface the scheduler uses |
| `heartbeats.ts` | `writeHeartbeat(section, now, summary)`, `readHeartbeats()` | `scheduler_heartbeats` is not project-owned, so no `crossProject` is needed |
| `schema-ready.ts` | `schemaIsReady(): Promise<boolean>` | worker start-up probe (D17); `false` on `42P01`/`42703`/connection errors |

`ProjectScope` (in `scope.ts`) gains repositories `accounts`, `slots`, `media`,
`posts`, `targets` and `attempts`. Each one is created for the scope's executor
(the db or a transaction) and its `project.id`, like the 001 repositories.
`dal/index.ts` exports the new types, `now`, `closeDb`, and the scheduler and
heartbeat functions.

## Query rules the scope recorder enforces (research F16)

- Every statement on these tables includes `<table>.project_id = $n`:
  - `social_accounts`, `posting_slots`, `media_assets`, `posts`, `post_media`, `post_targets`, `publish_attempts`.
- **Every join between two project-owned tables adds `a.project_id = b.project_id`**, e.g. `post_targets t JOIN social_accounts a ON a.id = t.social_account_id AND a.project_id = t.project_id`.
- Inserts list `project_id` in their column list.
- The scheduler's claim queries (which span projects) run inside `crossProject("scheduler: claim due targets")` / `crossProject("scheduler: claim token refresh")`.
- Everything after a claim (loading content, recording results, deriving post status) uses `forSchedulerProject(projectId)` and is pinned. The recorder must therefore see **no** cross-project reason for the record step.
- `tests/integration/scope-check.test.ts` gains cases that exercise each new repo.

## Locking order (deadlock avoidance)

| Transaction | Lock order |
|---|---|
| post services (queue, schedule, cancel, retry, resolve, update, delete) | `posts` row (`FOR UPDATE`) → its `post_targets` rows |
| queue actions on one account (pull forward, swap) | the posts of the involved targets (ordered by id) → the targets (ordered by id) |
| `removeAccount` | `social_accounts` row → its targets' posts (ordered by id) → targets |
| scheduler claim | targets `FOR UPDATE SKIP LOCKED` → accounts `FOR NO KEY UPDATE SKIP LOCKED`. It takes **no post lock**, and it never waits on any lock |
| post-status derivation after a claim | a separate short transaction per affected post, after the claim commits: `posts` row → read its targets (no target locks) → write `posts.status` |
| scheduler record | `posts` row → the target (guarded by `lease_owner`) → derive status in the same transaction |

Every transaction that waits on a lock takes the post lock before any target
lock. The claim, which locks targets and then accounts, never waits. So no
cycle can form:

- a service or record transaction blocked on a claimed target just waits for the claim to commit;
- `removeAccount` (account → posts → targets) can't block the claim, which skips locked accounts.

Derivation is correct without target locks. Each derivation runs under the
post lock and reads the latest committed targets, and every target change is
followed by a derivation that runs after it commits. So the last derivation
always sees the final state.

## Error classes (`src/server/dal/errors.ts`)

- `ValidationIssuesError(issues: ValidationIssue[] | Record<targetId, ValidationIssue[]>)`, `name = "ValidationIssuesError"`.
- `src/lib/action-result.ts` maps it to `validation` with the issues attached.
