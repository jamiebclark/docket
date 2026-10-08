import { sql, type SQL } from "drizzle-orm";
import { ATTENTION_MEMBER_OUTCOMES, CONNECT_FAILED, UNREAD_CAP } from "../../lib/notifications/attention";
import type { Database } from "../db/client";
import { notificationStates } from "../db/schema";

export interface NotificationStateRow {
  projectId: string;
  muted: boolean;
  /** A bigint as a decimal string, like `ActivityRecord.seq`. */
  seenSeq: string;
  seenAt: Date;
}

/** One project, one person. Every query is pinned to `projectId` and joins `member` for `userId`. */
export interface NotificationsRepo {
  get(): Promise<NotificationStateRow | null>;
  /** Attention events newer than the position, `muted = false` only, capped. 0 when muted or the row is missing. */
  unreadCount(cap?: number): Promise<number>;
  /** Inside a transaction that already holds the project lock (membership insert). */
  createAtCurrentPosition(): Promise<void>;
  /**
   * Its own transaction: SET LOCAL lock_timeout, projects FOR UPDATE, membership re-check, newest position,
   * GREATEST upsert. With `muted` given it also sets it; `markRead: true` moves the position.
   * Skips the lock when nothing newer is visible and `muted` is unchanged. Throws NotificationsBusyError on 55P03.
   */
  write(change: { markRead: boolean; muted?: boolean }): Promise<"changed" | "unchanged" | "not_member">;
}

/** Over a fixed project set (the caller's): every branch is pinned to one of `projectIds`. */
export interface NotificationsSetReader {
  /** One statement: UNION ALL of two branches per project, each LIMIT cap, outer count LIMIT cap. */
  countUnread(cap?: number): Promise<number>;
  /** Projects (muted or not) with any visible attention event newer than the position: the ones worth locking. */
  projectsWithUnread(): Promise<string[]>;
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
 * `select` is what each branch returns; `limit` bounds it.
 */
function unreadBranches(projectId: string, userId: string, select: SQL, limit: number, opts: { unmutedOnly: boolean }): SQL[] {
  const muted = opts.unmutedOnly ? sql`AND notification_states.muted = false` : sql``;
  const branch = (outcomeCond: SQL) => sql`(SELECT ${select} FROM activity_events
    JOIN notification_states ON notification_states.project_id = activity_events.project_id AND notification_states.user_id = ${userId}
    JOIN member ON member.organization_id = activity_events.project_id AND member.user_id = ${userId}
    WHERE activity_events.project_id = ${projectId} ${muted}
      AND ${outcomeCond}
      AND activity_events.seq > notification_states.seen_seq
    LIMIT ${limit})`;
  return [
    branch(sql`activity_events.outcome IN (${MEMBER_OUTCOMES})`),
    branch(sql`activity_events.outcome = ${CONNECT_FAILED_LITERAL} AND activity_events.actor_user_id = ${userId}`),
  ];
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
      const branches = unreadBranches(projectId, userId, sql`1`, cap, { unmutedOnly: true });
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
      if (current && !mutedChanges && (!change.markRead || !(await anyNewer()))) return "unchanged";
      try {
        return await db.transaction(async (raw) => {
          const tx = raw as unknown as Database;
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(lockTimeoutMs))}ms'`));
          await tx.execute(sql`SELECT projects.id FROM projects WHERE projects.id = ${projectId} FOR UPDATE`);
          if (afterLockHook) await afterLockHook();
          const stillMember = await tx.execute(
            sql`SELECT member.id FROM member WHERE member.organization_id = ${projectId} AND member.user_id = ${userId}`,
          );
          if (rowsOf(stillMember).length === 0) return "not_member" as const;
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
          return "changed" as const;
        });
      } catch (error) {
        if (errorCode(error) === "55P03") throw new NotificationsBusyError();
        throw error;
      }
    },
  };
}

export function createNotificationsSetReader(db: Database, projectIds: readonly string[], userId: string): NotificationsSetReader {
  return {
    async countUnread(cap = UNREAD_CAP) {
      if (projectIds.length === 0) return 0;
      const branches = projectIds.flatMap((p) => unreadBranches(p, userId, sql`1`, cap, { unmutedOnly: true }));
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
  };
}
