# Data model: Problem notifications

The decisions behind each shape are in [research.md](./research.md) (R1–R6). The interfaces are in [contracts/services.md](./contracts/services.md).

## 1. New table `notification_states` (project-owned)

There is one row per membership: a person's reading position and mute setting for one project. There is never one row per event (FR-001).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `project_id` | `uuid` | no | — | The scope column. Part of the PK and the FK. |
| `user_id` | `uuid` | no | — | Part of the PK and the FK. |
| `seen_seq` | `bigint` (`mode: "bigint"`) | no | `0` | Every attention event for this person in this project with `seq ≤ seen_seq` is read (R2). It only grows (R3). |
| `seen_at` | `timestamptz` | no | `now()` | When the position last moved, or when the row was created. Informational only; never compared with events. |
| `muted` | `boolean` | no | `false` | `true` means notifications are **off** for this project (N5). |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()`, `$onUpdate` | |

**Constraints**:

- **PK** `notification_states_pkey (project_id, user_id)`.
- **FK** `notification_states_member_fk`: `(project_id, user_id)` → `member (organization_id, user_id)` `ON DELETE CASCADE`. The target is the existing unique index `member_organization_user_uidx`.
  - It deletes the state with remove member and leave project, in the same statement and so the same transaction, and keeps it on rollback (FR-019).
  - It also deletes the state with project deletion (`organization` → `member`) and user deletion (`user` → `member`) (N8).
  - A role change (`UPDATE member SET role`) does not touch the key, so the state is kept.
- **CHECK** `notification_states_seen_seq_nonneg`: `seen_seq >= 0`.
- No other indexes. The PK serves every lookup, by `(project_id, user_id)` or within the caller's resolved set.

**Registration**:

- Add `{ table: "notification_states", scopeColumn: "project_id" }` to `projectOwnedTables` in `src/server/db/project-owned.ts`.
- Export the table from `src/server/db/schema/index.ts`. The schema lives in `src/server/db/schema/notifications.ts`.

**Lifecycle**:

| Event | Effect | Where |
|---|---|---|
| Project created | Insert `(project, creator, seen_seq = 0, muted = false)` | `createProject` transaction (`dal/projects.ts`) |
| Invitation accepted (by id or token) or sign-up | Insert `(project, user, seen_seq = newestAttentionSeq(project, user), muted = false)` | `MembersRepo.insert`, under the existing `withLockedProject` lock |
| First deploy | Insert for every existing `member`: `seen_seq = global max(seq)`, `ON CONFLICT DO NOTHING` | Custom migration (§3) |
| Mark read (N4.1–N4.3) | `seen_seq = GREATEST(seen_seq, S)`, `seen_at = now()` (upsert) | One locked transaction per project (R3) |
| Turn off (mute) | `muted = true`; position unchanged | Locked transaction (R3) |
| Turn on (unmute, N6) | `muted = false` and mark read in the same transaction | Locked transaction (R3) |
| Remove member, leave project, delete project or user | Row deleted by the FK cascade | Database |
| Rejoin | A new `member` row, so a new state row as for an accept | As for an accept |

**Missing row** (should not happen; R6):

- the person counts nothing for that project and lists as notifications on;
- the next mark or mute inserts the row at the current position.

## 2. Changes to `activity_events` (index-only; FR-021)

The log's columns, enums, CHECKs and existing four indexes are unchanged. Two partial indexes are added (R4):

| Index | Columns | `WHERE` | Serves |
|---|---|---|---|
| `activity_events_attention_seq_idx` | `(project_id, seq)` | `outcome IN ('failed', 'ambiguous', 'needs_reauth')` | Counting member-wide attention events with `seq > seen_seq`; `max(seq)` for the newest position |
| `activity_events_connect_failed_actor_idx` | `(project_id, actor_user_id, seq)` | `outcome = 'connect_failed'` | Counting the person's own connect failures; their `max(seq)` |

The outcome lists come from one constant in `src/lib/notifications/attention.ts`. The index `WHERE`s and every query that relies on them write the lists as SQL literals, never as parameters, so the planner can match the partial predicate.

**Writer change (R3).** `ActivityRepo.insert` runs `SELECT 1 FROM projects WHERE id = $1 FOR KEY SHARE` as its own statement before the `INSERT`. Nothing else changes for writers.

**Invariant recorded.** The identity sequence behind `seq` keeps `CACHE 1`. No migration may alter it (R3).

## 3. Migrations

| File | How | Contents |
|---|---|---|
| `drizzle/0015_<generated>.sql` | `pnpm db:generate` | `CREATE TABLE notification_states` with the PK, FK and CHECK; the two partial indexes on `activity_events` |
| `drizzle/0016_notification_states_start.sql` | `pnpm drizzle-kit generate --custom --name notification_states_start` | `INSERT INTO notification_states (project_id, user_id, seen_seq, seen_at) SELECT m.organization_id, m.user_id, (SELECT coalesce(max(seq), 0) FROM activity_events), now() FROM member m ON CONFLICT (project_id, user_id) DO NOTHING;` |

- **Global `max(seq)`.** It is read once through the unique `activity_events_seq_uq` index, and it is at least every project's own maximum, so every existing membership starts with everything read (FR-020, SC-006).
- **Idempotent.** Re-running adds nothing.
- **Order.** It runs after `0015`, in the existing migrate-at-start flow.

## 4. Derived concepts (not stored)

### Attention event (N1, FR-002)

For person `u` and project `p`, an event `e` with `e.project_id = p` is an attention event when either:

- `e.outcome ∈ {failed, ambiguous, needs_reauth}`; or
- `e.outcome = connect_failed` and `e.actor_user_id = u`.

A `connect_failed` event whose actor is null (a deleted user) matches nobody. `published`, `retrying` and `resolved` never match. The rule is implemented once as two SQL branches, with no `OR` (scope harness), and once as a pure predicate `isAttentionFor(event, userId)` used by tests and the panel model.

### Unread count (FR-003)

`unread(u)` = Σ over `p` in `u`'s current memberships with `notification_states.muted = false` of `#{ attention events e for (u, p) : e.seq > seen_seq(u, p) }`.

- **Cap.** The sum is capped at 100; work stops at 100 (R5).
- **Display**: `""` at 0, `"1"` to `"99"`, and `"99+"` from 100.
- **Accessible label**:
  - "No unread problems";
  - "1 unread problem";
  - "N unread problems";
  - "More than 99 unread problems".
- **Callout text**: "1 problem", "N problems", "More than 99 problems".

### Newest position (R3 step 4)

`newestAttentionSeq(p, u)` = `GREATEST(coalesce(max(seq) on index 1 for p, 0), coalesce(max(seq) on index 2 for (p, u), 0))`.

### Problems view scope (R7)

`problemsViewScope(pathname, search)` returns `null`, `{ kind: "project", slug }` or `{ kind: "all", slugs: string[] | null }`. It is not `null` exactly when all of these hold:

- the path is `/p/{slug}/activity` or `/activity`;
- the lenient filter's `preset === "problems"`;
- `platform`, `accountId`, `range`, `from` and `to` are null, and `invalidRange` is false;
- neither `before` nor `after` is present.

### Panel item (FR-011)

The serialisable view of one attention event, shared by the popover, `/notifications` and `GET /api/me/notifications/recent`:

```ts
interface NotificationItem {
  id: string;                       // activity event id
  outcome: "failed" | "ambiguous" | "needs_reauth" | "connect_failed";
  outcomeLabel: string;             // OUTCOME_LABEL, e.g. "Needs your decision"
  occurredAt: string;               // ISO 8601 UTC, whole ms
  project: { slug: string; name: string; timeZone: string };
  platforms: { key: string; name: string }[];   // one, or a connect group's several
  accountName: string | null;       // "Removed account" when removed; null for a group connect failure
  postDeleted: boolean;             // shows "Post deleted", as Activity does
  message: string;                  // the stored, already-scrubbed message (≤ 500 code points)
  isNew: boolean;                   // seq > the person's seen_seq for that project
  link: { href: string; label: string } | null;  // activityLink(), the same as Activity (P15)
}

interface NotificationPanel {
  state: "ok" | "all_muted" | "no_projects";
  items: NotificationItem[];        // up to 10, newest first by (occurred_at, seq); [] unless state = "ok"
  unread: { count: number; display: string; label: string };
}
```

- **Rows.** Rows come only from projects with notifications on, read and unread alike (spec assumption).
- **Order.** Newest first by `occurred_at DESC, seq DESC`, the same order as Activity.
- **No secrets.** Messages are the stored ones, already scrubbed at source (020 P9). Nothing else from `details` is exposed.

## 5. Validation rules

| Input | Rule | On failure |
|---|---|---|
| `projectSlug` (mute actions) | A string; must be one of the caller's resolved projects | `NotFoundError` → "That project could not be found." Nothing changes, and it is the same message whether or not the project exists (FR-009) |
| `on` (mute actions) | `"true"` or `"false"` (Zod `z.enum`) | Validation error; nothing changes |
| `returnTo` (`markAllRead`) | Absent, or exactly `/notifications` | Treated as absent |
| Refresh and panel requests | No input is read (query and body ignored) | — |
