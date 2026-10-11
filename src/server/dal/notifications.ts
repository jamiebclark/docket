import { sql, type SQL } from "drizzle-orm";
import { ATTENTION_MEMBER_OUTCOMES, CONNECT_FAILED, EVENT_MARK_CAP, UNREAD_CAP } from "../../lib/notifications/attention";
import type { Database } from "../db/client";
import { notificationStates } from "../db/schema";

export interface NotificationStateRow {
  projectId: string;
  muted: boolean;
  /** A bigint as a decimal string, like `ActivityRecord.seq`. */
  seenSeq: string;
  seenAt: Date;
}

/** What a row action did. `atCap` and `notFound` wrote nothing. */
export type MarkOutcome =
  | { kind: "changed"; floorMoved: boolean }
  | { kind: "unchanged" } // the floor is already at or past the event (M10)
  | { kind: "not_found" } // no such attention event for this person in this project (N23)
  | { kind: "at_cap" } // EVENT_MARK_CAP reached for this project (FR-007)
  | { kind: "not_member" };

export interface WriteOutcome {
  outcome: "changed" | "unchanged" | "not_member";
  /** Pruned marks whose instant was finite and still in the future — what the confirmation names (FR-013). */
  snoozesCleared: number;
}

/** One project, one person. Every query is pinned to `projectId` and joins `member` for `userId`. */
export interface NotificationsRepo {
  get(): Promise<NotificationStateRow | null>;
  /** Attention events above the floor with no mark still in the future, `muted = false` only, capped. */
  unreadCount(cap?: number): Promise<number>;
  /** Inside a transaction that already holds the project lock (membership insert). */
  createAtCurrentPosition(): Promise<void>;
  /**
   * Its own transaction: SET LOCAL lock_timeout, projects FOR UPDATE, membership re-check, newest position,
   * GREATEST upsert. With `muted` given it also sets it; `markRead: true` moves the position, pruning every
   * mark at or below the new floor in the same transaction and reporting how many live snoozes that cleared.
   * Skips the lock when nothing newer is visible and `muted` is unchanged. Throws NotificationsBusyError on 55P03.
   */
  write(change: { markRead: boolean; muted?: boolean }): Promise<WriteOutcome>;
  /**
   * One row action, in the same transaction order as `write` (M12). `countsAgainAt: "never"` is "Mark read";
   * a Date is a snooze. Resolves the event inside this project with the attention predicate, refuses at or
   * below the floor and at the cap, upserts the mark, then pulls the floor up as far as the oldest uncovered
   * event allows and prunes (M7). Throws NotificationsBusyError on a lock timeout, having written nothing.
   */
  markEvent(input: { eventId: string; countsAgainAt: Date | "never" }): Promise<MarkOutcome>;
  /** How many marks this person holds for this project (cap surfacing). */
  markCount(): Promise<number>;
}

/** Over a fixed project set (the caller's): every branch is pinned to one of `projectIds`. */
export interface NotificationsSetReader {
  /** One statement: UNION ALL of two mark-aware branches per project, each LIMIT cap, outer count LIMIT cap. */
  countUnread(cap?: number): Promise<number>;
  /** Projects (muted or not) with any visible attention event newer than the position: the ones worth locking. */
  projectsWithUnread(): Promise<string[]>;
  /** The caller's attention event with this id, in one of the given projects, or null (N23, M11). */
  resolveAttentionEvent(eventId: string): Promise<{ projectId: string; seq: bigint } | null>;
  /** Marks per project for this person, for `actionsAvailable` (FR-020). Projects with none are absent. */
  markCounts(): Promise<Map<string, number>>;
  /** The soonest live snooze over the given (notifications-on) projects, or null (FR-021, M17). */
  nextChangeAt(): Promise<Date | null>;
}

/** The lock wait gave up (SQLSTATE 55P03): nothing was written. */
export class NotificationsBusyError extends Error {
  constructor(message = "Could not save. Try again.") {
    super(message);
    this.name = "NotificationsBusyError";
  }
}

let lockTimeoutMs = 2000;

/** Lowers the lock wait so a test can provoke the timeout quickly. */
export function setNotificationsLockTimeoutForTests(ms: number): void {
  lockTimeoutMs = ms;
}

let afterLockHook: (() => Promise<void>) | null = null;

/** Runs after `write` takes the project lock and before it reads the newest position, so a test can interleave a writer. */
export function setNotificationsAfterLockHookForTests(hook: (() => Promise<void>) | null): void {
  afterLockHook = hook;
}

// Literals, never parameters, so the planner can match the partial indexes' predicates.
const MEMBER_OUTCOMES = sql.raw(ATTENTION_MEMBER_OUTCOMES.map((o) => `'${o}'`).join(", "));
const CONNECT_FAILED_LITERAL = sql.raw(`'${CONNECT_FAILED}'`);

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

function errorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

/**
 * The two attention branches for one project and person: unmuted, still a member, newer than the position.
 * `select` is what each branch returns; `limit` bounds it. `excludeMarked` adds the hidden-now anti-join
 * (a mark whose instant is still in the future — a read-for-ever or a live snooze), so the exclusion runs
 * before `limit` applies within the branch (data-model.md §4.1). `projectsWithUnread` deliberately leaves
 * this off: a project whose only events above the floor are marked still needs its floor raised and pruned.
 */
function unreadBranches(
  projectId: string,
  userId: string,
  select: SQL,
  limit: number,
  opts: { unmutedOnly: boolean; excludeMarked?: boolean },
): SQL[] {
  const muted = opts.unmutedOnly ? sql`AND notification_states.muted = false` : sql``;
  const markJoin = opts.excludeMarked
    ? sql`LEFT JOIN notification_event_marks hidden
        ON hidden.project_id = activity_events.project_id
       AND hidden.user_id = ${userId}
       AND hidden.event_id = activity_events.id
       AND hidden.counts_again_at > now()`
    : sql``;
  const markFilter = opts.excludeMarked ? sql`AND hidden.event_id IS NULL` : sql``;
  const branch = (outcomeCond: SQL) => sql`(SELECT ${select} FROM activity_events
    JOIN notification_states ON notification_states.project_id = activity_events.project_id AND notification_states.user_id = ${userId}
    JOIN member ON member.organization_id = activity_events.project_id AND member.user_id = ${userId}
    ${markJoin}
    WHERE activity_events.project_id = ${projectId} ${muted}
      AND ${outcomeCond}
      AND activity_events.seq > notification_states.seen_seq
      ${markFilter}
    LIMIT ${limit})`;
  return [
    branch(sql`activity_events.outcome IN (${MEMBER_OUTCOMES})`),
    branch(sql`activity_events.outcome = ${CONNECT_FAILED_LITERAL} AND activity_events.actor_user_id = ${userId}`),
  ];
}

/**
 * This event's `seq`, if it is an attention event for this person in this project — the two outcome
 * branches resolved separately (no `OR`, M15) so each pins `project_id` on its own.
 */
async function resolveAttentionEventSeq(tx: Database, projectId: string, userId: string, eventId: string): Promise<bigint | null> {
  const branch = (outcomeCond: SQL) => sql`(SELECT activity_events.seq FROM activity_events
    WHERE activity_events.project_id = ${projectId} AND activity_events.id = ${eventId}
      AND ${outcomeCond})`;
  const branches = [
    branch(sql`activity_events.outcome IN (${MEMBER_OUTCOMES})`),
    branch(sql`activity_events.outcome = ${CONNECT_FAILED_LITERAL} AND activity_events.actor_user_id = ${userId}`),
  ];
  const result = await tx.execute(sql`SELECT seq::text AS seq FROM (${sql.join(branches, sql` UNION ALL `)}) AS resolved LIMIT 1`);
  const seq = rowsOf(result)[0]?.seq as string | undefined;
  return seq === undefined ? null : BigInt(seq);
}

/**
 * The first (lowest-seq) attention event above `floor` with no read-for-ever mark — the floor-follow
 * (data-model.md §4.2). `null` when every attention event above `floor` is marked read for ever, meaning
 * the floor can rise all the way to the newest attention seq.
 */
async function firstUncoveredAttentionSeq(tx: Database, projectId: string, userId: string, floor: bigint): Promise<bigint | null> {
  const branch = (outcomeCond: SQL) => sql`(SELECT activity_events.seq FROM activity_events
    LEFT JOIN notification_event_marks covered
           ON covered.project_id = activity_events.project_id
          AND covered.user_id    = ${userId}
          AND covered.event_id   = activity_events.id
          AND covered.counts_again_at = 'infinity'::timestamptz
    WHERE activity_events.project_id = ${projectId}
      AND ${outcomeCond}
      AND activity_events.seq > ${floor.toString()}::bigint
      AND covered.event_id IS NULL
    ORDER BY activity_events.seq LIMIT 1)`;
  const branches = [
    branch(sql`activity_events.outcome IN (${MEMBER_OUTCOMES})`),
    branch(sql`activity_events.outcome = ${CONNECT_FAILED_LITERAL} AND activity_events.actor_user_id = ${userId}`),
  ];
  const result = await tx.execute(sql`SELECT min(seq)::text AS seq FROM (${sql.join(branches, sql` UNION ALL `)}) AS uncovered`);
  const seq = rowsOf(result)[0]?.seq as string | null | undefined;
  return seq === null || seq === undefined ? null : BigInt(seq);
}

/**
 * Deletes every mark at or below `newFloor` for this project and person, in the caller's transaction, and
 * reports how many of the pruned marks were live snoozes — counted in SQL so no infinite instant crosses
 * into TypeScript (data-model.md §4.3, the driver note).
 */
async function pruneMarks(tx: Database, projectId: string, userId: string, newFloor: bigint): Promise<number> {
  const result = await tx.execute(sql`
    WITH pruned AS (
      DELETE FROM notification_event_marks
       WHERE project_id = ${projectId} AND user_id = ${userId} AND event_seq <= ${newFloor.toString()}::bigint
      RETURNING counts_again_at
    )
    SELECT count(*) FILTER (
             WHERE counts_again_at > now() AND counts_again_at < 'infinity'::timestamptz
           )::int AS snoozes_cleared
      FROM pruned`);
  return Number(rowsOf(result)[0]?.snoozes_cleared ?? 0);
}

/** The newest attention `seq` for this person in this project: two index probes, `GREATEST`ed. */
export async function newestAttentionSeq(db: Database, projectId: string, userId: string): Promise<bigint> {
  const result = await db.execute(sql`SELECT GREATEST(
      coalesce((SELECT max(activity_events.seq) FROM activity_events
        WHERE activity_events.project_id = ${projectId} AND activity_events.outcome IN (${MEMBER_OUTCOMES})), 0),
      coalesce((SELECT max(activity_events.seq) FROM activity_events
        WHERE activity_events.project_id = ${projectId} AND activity_events.outcome = ${CONNECT_FAILED_LITERAL}
          AND activity_events.actor_user_id = ${userId}), 0)
    )::text AS newest`);
  return BigInt(String(rowsOf(result)[0]?.newest ?? "0"));
}

export function createNotificationsRepo(db: Database, projectId: string, userId: string): NotificationsRepo {
  async function get(): Promise<NotificationStateRow | null> {
    const result = await db.execute(sql`SELECT notification_states.project_id AS project_id, notification_states.muted AS muted,
        notification_states.seen_seq::text AS seen_seq,
        to_char(notification_states.seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS seen_iso
      FROM notification_states
      WHERE notification_states.project_id = ${projectId} AND notification_states.user_id = ${userId}`);
    const r = rowsOf(result)[0];
    if (!r) return null;
    return { projectId: r.project_id as string, muted: r.muted as boolean, seenSeq: r.seen_seq as string, seenAt: new Date(r.seen_iso as string) };
  }

  async function anyNewer(): Promise<boolean> {
    const branches = unreadBranches(projectId, userId, sql`1`, 1, { unmutedOnly: false });
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM (${sql.join(branches, sql` UNION ALL `)}) AS newer`);
    return Number(rowsOf(result)[0]?.n ?? 0) > 0;
  }

  return {
    get,
    async unreadCount(cap = UNREAD_CAP) {
      const branches = unreadBranches(projectId, userId, sql`1`, cap, { unmutedOnly: true, excludeMarked: true });
      const result = await db.execute(
        sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM (${sql.join(branches, sql` UNION ALL `)}) AS b LIMIT ${cap}) AS c`,
      );
      return Number(rowsOf(result)[0]?.n ?? 0);
    },
    async createAtCurrentPosition() {
      const seenSeq = await newestAttentionSeq(db, projectId, userId);
      await db.insert(notificationStates).values({ projectId, userId, seenSeq }).onConflictDoNothing();
    },
    async write(change) {
      const current = await get();
      const mutedChanges = change.muted !== undefined && (current === null || change.muted !== current.muted);
      if (current && !mutedChanges && (!change.markRead || !(await anyNewer()))) return { outcome: "unchanged", snoozesCleared: 0 };
      try {
        return await db.transaction(async (raw) => {
          const tx = raw as unknown as Database;
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(lockTimeoutMs))}ms'`));
          await tx.execute(sql`SELECT projects.id FROM projects WHERE projects.id = ${projectId} FOR UPDATE`);
          if (afterLockHook) await afterLockHook();
          const stillMember = await tx.execute(
            sql`SELECT member.id FROM member WHERE member.organization_id = ${projectId} AND member.user_id = ${userId}`,
          );
          if (rowsOf(stillMember).length === 0) return { outcome: "not_member", snoozesCleared: 0 } as const;
          const newest = await newestAttentionSeq(tx, projectId, userId);
          const set: Record<string, unknown> = { updatedAt: new Date() };
          if (change.markRead) {
            set.seenSeq = sql`GREATEST(${notificationStates.seenSeq}, excluded.seen_seq)`;
            set.seenAt = new Date();
          }
          if (change.muted !== undefined) set.muted = change.muted;
          await tx
            .insert(notificationStates)
            .values({ projectId, userId, seenSeq: newest, muted: change.muted ?? false })
            .onConflictDoUpdate({ target: [notificationStates.projectId, notificationStates.userId], set });
          const snoozesCleared = change.markRead ? await pruneMarks(tx, projectId, userId, newest) : 0;
          return { outcome: "changed", snoozesCleared } as const;
        });
      } catch (error) {
        if (errorCode(error) === "55P03") throw new NotificationsBusyError();
        throw error;
      }
    },
    async markEvent(input) {
      try {
        return await db.transaction(async (raw) => {
          const tx = raw as unknown as Database;
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(lockTimeoutMs))}ms'`));
          await tx.execute(sql`SELECT projects.id FROM projects WHERE projects.id = ${projectId} FOR UPDATE`);
          if (afterLockHook) await afterLockHook();
          const stillMember = await tx.execute(
            sql`SELECT member.id FROM member WHERE member.organization_id = ${projectId} AND member.user_id = ${userId}`,
          );
          if (rowsOf(stillMember).length === 0) return { kind: "not_member" } as const;
          const seq = await resolveAttentionEventSeq(tx, projectId, userId, input.eventId);
          if (seq === null) return { kind: "not_found" } as const;
          const positionRow = await tx.execute(
            sql`SELECT notification_states.seen_seq::text AS seen_seq FROM notification_states
                WHERE notification_states.project_id = ${projectId} AND notification_states.user_id = ${userId}`,
          );
          const seenSeq = BigInt(String(rowsOf(positionRow)[0]?.seen_seq ?? "0"));
          if (seq <= seenSeq) return { kind: "unchanged" } as const;
          const countRow = await tx.execute(
            sql`SELECT count(*)::int AS n FROM notification_event_marks WHERE project_id = ${projectId} AND user_id = ${userId}`,
          );
          if (Number(rowsOf(countRow)[0]?.n ?? 0) >= EVENT_MARK_CAP) return { kind: "at_cap" } as const;
          const countsAgainAt =
            input.countsAgainAt === "never" ? sql`'infinity'::timestamptz` : sql`${input.countsAgainAt.toISOString()}::timestamptz`;
          await tx.execute(sql`
            INSERT INTO notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
            VALUES (${projectId}, ${userId}, ${input.eventId}, ${seq.toString()}::bigint, ${countsAgainAt})
            ON CONFLICT (project_id, user_id, event_id)
            DO UPDATE SET counts_again_at = excluded.counts_again_at, updated_at = now()`);
          const uncoveredSeq = await firstUncoveredAttentionSeq(tx, projectId, userId, seenSeq);
          const newFloor = uncoveredSeq === null ? await newestAttentionSeq(tx, projectId, userId) : uncoveredSeq - 1n;
          let floorMoved = false;
          if (newFloor > seenSeq) {
            await tx.execute(
              sql`UPDATE notification_states SET seen_seq = ${newFloor.toString()}::bigint, seen_at = now(), updated_at = now()
                  WHERE project_id = ${projectId} AND user_id = ${userId}`,
            );
            await pruneMarks(tx, projectId, userId, newFloor);
            floorMoved = true;
          }
          return { kind: "changed", floorMoved } as const;
        });
      } catch (error) {
        if (errorCode(error) === "55P03") throw new NotificationsBusyError();
        throw error;
      }
    },
    async markCount() {
      const result = await db.execute(
        sql`SELECT count(*)::int AS n FROM notification_event_marks WHERE project_id = ${projectId} AND user_id = ${userId}`,
      );
      return Number(rowsOf(result)[0]?.n ?? 0);
    },
  };
}

export function createNotificationsSetReader(db: Database, projectIds: readonly string[], userId: string): NotificationsSetReader {
  return {
    async countUnread(cap = UNREAD_CAP) {
      if (projectIds.length === 0) return 0;
      const branches = projectIds.flatMap((p) => unreadBranches(p, userId, sql`1`, cap, { unmutedOnly: true, excludeMarked: true }));
      const result = await db.execute(
        sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM (${sql.join(branches, sql` UNION ALL `)}) AS b LIMIT ${cap}) AS c`,
      );
      return Number(rowsOf(result)[0]?.n ?? 0);
    },
    async projectsWithUnread() {
      if (projectIds.length === 0) return [];
      const branches = projectIds.flatMap((p) => unreadBranches(p, userId, sql`activity_events.project_id AS project_id`, 1, { unmutedOnly: false }));
      const result = await db.execute(sql`SELECT DISTINCT project_id FROM (${sql.join(branches, sql` UNION ALL `)}) AS b`);
      return rowsOf(result).map((r) => r.project_id as string);
    },
    async resolveAttentionEvent(eventId) {
      if (projectIds.length === 0) return null;
      const branches = projectIds.flatMap((p) => {
        const branch = (outcomeCond: SQL) => sql`(SELECT ${p}::uuid AS project_id, activity_events.seq AS seq FROM activity_events
          WHERE activity_events.project_id = ${p} AND activity_events.id = ${eventId} AND ${outcomeCond})`;
        return [
          branch(sql`activity_events.outcome IN (${MEMBER_OUTCOMES})`),
          branch(sql`activity_events.outcome = ${CONNECT_FAILED_LITERAL} AND activity_events.actor_user_id = ${userId}`),
        ];
      });
      const result = await db.execute(
        sql`SELECT project_id, seq::text AS seq FROM (${sql.join(branches, sql` UNION ALL `)}) AS resolved LIMIT 1`,
      );
      const r = rowsOf(result)[0] as { project_id: string; seq: string } | undefined;
      return r === undefined ? null : { projectId: r.project_id, seq: BigInt(r.seq) };
    },
    async markCounts() {
      if (projectIds.length === 0) return new Map();
      const branches = projectIds.map(
        (p) => sql`(SELECT ${p}::uuid AS project_id, count(*)::int AS n FROM notification_event_marks
          WHERE project_id = ${p} AND user_id = ${userId})`,
      );
      const result = await db.execute(sql`SELECT project_id, n FROM (${sql.join(branches, sql` UNION ALL `)}) AS counted WHERE n > 0`);
      return new Map(rowsOf(result).map((r) => [r.project_id as string, Number(r.n)]));
    },
    async nextChangeAt() {
      if (projectIds.length === 0) return null;
      const branches = projectIds.map(
        (p) => sql`(SELECT min(counts_again_at) AS next FROM notification_event_marks
          WHERE project_id = ${p} AND user_id = ${userId}
            AND counts_again_at > now() AND counts_again_at < 'infinity'::timestamptz)`,
      );
      const result = await db.execute(
        sql`SELECT to_char(min(next) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_iso
            FROM (${sql.join(branches, sql` UNION ALL `)}) AS b`,
      );
      const nextIso = rowsOf(result)[0]?.next_iso as string | null | undefined;
      return nextIso ? new Date(nextIso) : null;
    },
  };
}
