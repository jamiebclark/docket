# Contract: DAL, services and call sites

Shapes are in [../data-model.md](../data-model.md); the reasons are in [../research.md](../research.md). Route handlers, server actions and pages import **services only**, never `src/server/db` (constitution III, lint rule).

## 1. DAL

### 1.1 `src/server/dal/notifications.ts` (new)

```ts
export interface NotificationStateRow {
  projectId: string;
  muted: boolean;
  seenSeq: string;          // bigint as a decimal string, like ActivityRecord.seq
  seenAt: Date;
}

/** One project, one person. Every query is pinned to `projectId` and joins `member` for `userId`. */
export interface NotificationsRepo {
  get(): Promise<NotificationStateRow | null>;
  /** Attention events newer than the position, `muted = false` only, capped. 0 when muted or the row is missing. */
  unreadCount(cap?: number): Promise<number>;                        // cap defaults to 100
  /** Inside a transaction that already holds the project lock (membership insert). */
  createAtCurrentPosition(): Promise<void>;
  /**
   * Its own transaction: SET LOCAL lock_timeout, projects FOR UPDATE, membership re-check, newest position,
   * GREATEST upsert. With `muted` given it also sets it; `markRead: true` moves the position.
   * Skips the lock when nothing newer is visible and `muted` is unchanged. Throws NotificationsBusyError on 55P03.
   */
  write(change: { markRead: boolean; muted?: boolean }): Promise<"changed" | "unchanged" | "not_member">;
}

export function createNotificationsRepo(db: Database, projectId: string, userId: string): NotificationsRepo;

/** Over a fixed project set (the caller's): every branch is pinned to one of `projectIds`. */
export interface NotificationsSetReader {
  /** One statement: UNION ALL of two branches per project, each LIMIT cap, outer count LIMIT cap (R5). */
  countUnread(cap?: number): Promise<number>;
  /** Projects (muted or not) with any visible attention event newer than the position: the ones worth locking. */
  projectsWithUnread(): Promise<string[]>;
}

export function createNotificationsSetReader(db: Database, projectIds: readonly string[], userId: string): NotificationsSetReader;

export function newestAttentionSeq(db: Database, projectId: string, userId: string): Promise<bigint>; // R3 step 4

export class NotificationsBusyError extends Error {}                  // lock_timeout (55P03)
```

**SQL rules**:

- No `OR`, and no `NOT` other than `IS NOT NULL`.
- Every `activity_events`, `notification_states` and `member` reference is pinned by `= $n` or linked to a pinned alias by a scope-column join.
- Attention outcomes are SQL literals from `ATTENTION_MEMBER_OUTCOMES` and `"connect_failed"` (`src/lib/notifications/attention.ts`).
- `lock_timeout` is `'2s'`. A test hook, `setNotificationsLockTimeoutForTests(ms)`, may lower it.

### 1.2 `src/server/dal/activity.ts` (changed)

- **`insert`**: first `SELECT 1 FROM projects WHERE id = $1 FOR KEY SHARE` (its own statement), then the existing insert (R3). The signature is unchanged.
- **New reader method `listAttention`** on `createActivityReader(...)`:

  ```ts
  listAttention(q: { projectIds: readonly string[]; userId: string; limit: number }): Promise<ActivityRecord[]>;
  ```

  - Every id must be in the reader's allowed set, or it throws before any SQL.
  - Per project it builds **four** `listBranch` sub-selects, each with `limit` and one `outcome = <literal>` equality: `failed`, `ambiguous`, `needs_reauth`, and `connect_failed` plus `actor_user_id = $u`.
  - The sub-selects are joined with `UNION ALL`, ordered `occurred_at DESC, seq DESC` and limited to `limit`.
  - Each branch takes its rows off the index before the display joins (the 020 pattern), and keeps the `member` join when the reader has `memberUserId`.

  `listBranch` gains an internal option for an equality outcome and an actor equality. `list` and `summary` produce exactly the SQL they did before.

### 1.3 `src/server/dal/members.ts` and `src/server/dal/projects.ts` (changed)

- **`MembersRepo.insert(userId, role)`** inserts the `member` row and then `createNotificationsRepo(db, projectId, userId).createAtCurrentPosition()`, on the same executor. Its callers already hold the project lock (F4).
- **`createProject`** inserts `notification_states (org.id, userId, seen_seq = 0)` right after the owner `member` row, in its transaction.

### 1.4 `src/server/dal/scope.ts` (changed)

`ProjectScope` gains:

```ts
readonly notifications: NotificationsRepo;      // createNotificationsRepo(exec, project.id, membership.userId)
```

- **Members** get it pinned to their own user id.
- **The job runner and API-key scopes** get a repo whose methods throw `ForbiddenError`. API keys belong to projects, not people.

### 1.5 `src/server/dal/my-projects.ts` (changed)

- **Resolution query.** It gains `LEFT JOIN notification_states ON (project_id, user_id)`, in the same `crossProject("resolve my projects")` section. Each `MyProject` gains:

  ```ts
  notifications: { muted: boolean; seenSeq: string } | null;   // null: no row (R6)
  ```

- **`ProjectSetScope` additions**:

  ```ts
  readonly notifications: {
    countUnread(): Promise<number>;                                        // in the project-set section
    recent(limit: number): Promise<ActivityRecord[]>;                      // listAttention over unmuted projects
    projectsWithUnread(): Promise<string[]>;
    /** One locked transaction per project id; ids outside the set throw NotFoundError before any SQL. */
    write(projectId: string, change: { markRead: boolean; muted?: boolean }): Promise<"changed" | "unchanged" | "not_member">;
  };
  ```

- **Section.** Every statement runs inside `runForProjectSet({ reason: "notifications: my projects", projectIds })`.
- **Projects counted.** `countUnread` and `recent` cover only the set's projects with `notifications?.muted === false`, and the SQL re-checks `muted = false` itself.

### 1.6 `src/server/db/project-owned.ts`, `schema/index.ts`, `schema/notifications.ts`

As in data-model §1–§2. `src/server/db/project-owned.test.ts` keeps checking that every table with a project scope column is listed.

## 2. Services: `src/server/services/notifications/`

### 2.1 `index.ts`

```ts
export interface UnreadSummary { count: number; display: string; label: string }

/** Header and refresh. Callers resolve the session first; an empty set gives { 0, "", "No unread problems" }. */
export async function unreadSummary(set: ProjectSetScope): Promise<UnreadSummary>;

/** Panel model (data-model §4): state, up to 10 items, and the unread summary. */
export async function recentPanel(set: ProjectSetScope, now: Date): Promise<NotificationPanel>;

/** N4.1: every project in the set, muted or not. Locks only projects with something newer. */
export async function markAllRead(set: ProjectSetScope): Promise<{ marked: number; busy: string[] /* project names */ }>;

/** N4.2/N4.3 for a request: resolves `scope` against the set; unknown slugs mark nothing. Swallows NotificationsBusyError. */
export async function markProblemsView(set: ProjectSetScope, scope: ProblemsViewScope): Promise<void>;

/** FR-007/N6 from the Notifications page. `on` = true also marks read. Slug outside the set → NotFoundError. */
export async function setNotificationsBySlug(set: ProjectSetScope, input: unknown): Promise<{ projectName: string; on: boolean }>;

/** The same from project settings, for the caller's own state. */
export async function setMyProjectNotifications(scope: ProjectScope, input: unknown): Promise<{ on: boolean }>;

/** Callout (FR-017): 0 when muted. */
export async function projectUnread(scope: ProjectScope): Promise<{ count: number; text: string }>;

/** Settings card and Notifications page list. */
export async function myProjectStates(set: ProjectSetScope): Promise<{ slug: string; name: string; on: boolean }[]>;
export async function myStateForProject(scope: ProjectScope): Promise<{ on: boolean }>;
```

- **Input schema.** `{ projectSlug: z.string().min(1), on: z.enum(["true", "false"]) }` (a `projectSlug` is not read by `setMyProjectNotifications`).
- **Permissions.**
  - Every member role may read and write their **own** state. There is no role check beyond membership, because every role has `post: view` (spec assumption).
  - Calls through a job-runner or API-key scope throw `ForbiddenError`.

### 2.2 `view-mark.ts` (pure)

```ts
export type ProblemsViewScope = { kind: "project"; slug: string } | { kind: "all"; slugs: string[] | null };
export function problemsViewScope(pathname: string, search: URLSearchParams): ProblemsViewScope | null;   // R7
export function isPrefetch(headers: Headers): boolean;                                                    // R9
```

### 2.3 `panel.ts` (pure)

`toNotificationItem(record: ActivityRecord, seenSeqByProject: Map<string, bigint>): NotificationItem` reuses `toActivityRow`'s platform, account and link logic. The shared parts are factored out of `services/activity/index.ts`, not copied.

### 2.4 `src/lib/notifications/` (pure, shared with the client)

- `attention.ts`: `ATTENTION_MEMBER_OUTCOMES = ["failed", "ambiguous", "needs_reauth"] as const`, `CONNECT_FAILED = "connect_failed"`, `isAttentionFor(e, userId)`, `UNREAD_CAP = 100`.
- `text.ts`:
  - `unreadDisplay(n)`: `""`, `"1"` … `"99"`, `"99+"`;
  - `unreadLabel(n)`;
  - `calloutCountText(n)`;
  - `mutedConfirmation(name, on)`.

## 3. Request glue: `src/components/notifications/request.ts` (server only)

```ts
/** React cache(): once per request. Reads x-docket-path and the prefetch headers; marks via the service. */
export const ensureProblemsViewMarked: () => Promise<void>;
```

- **Callers.**
  1. `NotificationBell` (server part), before `unreadSummary`.
  2. `src/app/p/[projectSlug]/activity/page.tsx`, before `listProjectActivity`.
  3. `src/app/activity/page.tsx`, before `listMyActivity`, and before it renders `SignedInHeader`.
- **Never throws.** No session, a prefetch, a non-qualifying URL or a busy lock are all no-ops.

`src/proxy.ts` sets `requestHeaders.set("x-docket-path", pathname + search)` beside `x-nonce`, overwriting any client value.

## 4. Changed call sites (summary)

| File | Change |
|---|---|
| `src/server/dal/activity.ts` | `FOR KEY SHARE` before insert; `listAttention`; `listBranch` equality option |
| `src/server/dal/members.ts`, `dal/projects.ts` | Create the state row with the membership |
| `src/server/dal/scope.ts`, `dal/my-projects.ts`, `dal/index.ts` | `notifications` repos and readers; exports `NotificationsBusyError` and types |
| `src/server/services/activity/index.ts` | Factor the row-building helpers that `panel.ts` reuses; no behaviour change |
| `src/components/shell/SignedInHeader.tsx` | Renders `NotificationBell` between `InvitationBadge` and `UserMenu` |
| `src/components/shell/UserMenu.tsx` | Adds a "Notifications" link (`/notifications`, icon `slidersHorizontal`) |
| `src/components/shell/SchedulerHealth.tsx` | Imports `relativeTimeText` (same output) |
| `src/components/activity/ActivitySummary.tsx` | `prefetch={false}` on the preset links |
| `src/app/p/[projectSlug]/activity/page.tsx`, `src/app/activity/page.tsx` | `await ensureProblemsViewMarked()` first |
| `src/app/p/[projectSlug]/page.tsx`, `posts/page.tsx` | `ProblemsCallout` at the top |
| `src/app/p/[projectSlug]/settings/page.tsx`, `actions.ts` | "Your notifications" card and `setMyProjectNotifications` action |
| `src/proxy.ts`, `src/lib/auth-gate.ts` | `x-docket-path`; `/api/me/` public prefix |
| `scripts/generate-icons.mjs` → `icons.generated.ts` | `bell` and `slidersHorizontal` (`pnpm icons`) |

## 5. Scope harness

No harness change is needed. The new statements use the existing project-set section and the existing pin and link rules. New tests assert:

- the count, `recent` and `projectsWithUnread` statements are all recorded inside `runForProjectSet`, and every pin is in the caller's set;
- a crafted id outside the set throws before any SQL;
- per-project `NotificationsRepo` statements are pinned to the scope's project.
