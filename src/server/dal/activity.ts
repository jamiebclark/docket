import { sql, type SQL } from "drizzle-orm";
import { PROBLEM_OUTCOMES, SUCCESS_OUTCOMES, KIND_OUTCOME, type ActivityKind, type ActivityOutcome } from "../../lib/activity/outcomes";
import { activityDetailsSchema, type ActivityDetails } from "../../lib/activity/details";
import { clipMessage } from "../../lib/activity/text";
import type { Database } from "../db/client";
import { activityEvents } from "../db/schema";

export interface NewActivityEvent {
  /** The outcome is derived from `KIND_OUTCOME`, never passed. */
  kind: ActivityKind;
  /** The caller's `clock.now()`; stored to whole milliseconds. */
  occurredAt: Date;
  postId?: string | null;
  postTargetId?: string | null;
  socialAccountId?: string | null;
  /** Null only for a group-level connect failure. */
  providerKey: string | null;
  providerKeys?: readonly string[];
  groupKey?: string | null;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  /** Clipped by `insert`; callers pass scrubbed text. */
  message: string;
  /** Parsed with the strict union for `kind`; a mismatch is a programming error and throws. */
  details: ActivityDetails;
}

/** The `(occurred_at, seq)` position a page continues from. `seq` is a bigint carried as a decimal string. */
export interface ActivityPosition {
  occurredAt: Date;
  seq: string;
}

/** One project's slice of a query: its id, its own [from, to) window and the shared filters. */
export interface BranchQuery {
  windows: { projectId: string; from: Date | null; to: Date | null }[];
  outcomes: readonly ActivityOutcome[] | null;
  platform: string | null;
  accountId: string | null;
}

export interface ActivityRecord {
  id: string;
  seq: string;
  projectId: string;
  occurredAt: Date;
  kind: ActivityKind;
  outcome: ActivityOutcome;
  postId: string | null;
  postTargetId: string | null;
  socialAccountId: string | null;
  providerKey: string | null;
  providerKeys: string[];
  groupKey: string | null;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  message: string;
  details: Record<string, unknown>;
  projectSlug: string;
  projectName: string;
  projectTimeZone: string;
  accountName: string | null;
  accountRemovedAt: Date | null;
  postDeletedAt: Date | null;
  /** `override_text ?? base_text`; null when the post is gone. */
  postText: string | null;
  targetStatus: string | null;
}

/** Append-only: insert, list, summary. No update or delete (FR-008). */
export interface ActivityRepo {
  insert(event: NewActivityEvent): Promise<{ id: string }>;
  /** Newest first. Returns up to `limit + 1` rows so the caller can tell whether another page exists. */
  list(q: BranchQuery & { cursor: ActivityPosition | null; direction: "older" | "newer"; limit: number }): Promise<ActivityRecord[]>;
  summary(q: BranchQuery): Promise<{ successes: number; problems: number }>;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function iso(column: string): SQL {
  return sql.raw(`to_char(${column} AT TIME ZONE 'UTC', ${ISO})`);
}

function toDate(value: unknown): Date | null {
  return typeof value === "string" ? new Date(value) : null;
}

/** The WHERE conditions of one branch. Plain AND-ed predicates only: no OR or NOT, so every one is easy to audit. */
function branchConditions(
  window: BranchQuery["windows"][number],
  q: BranchQuery,
  position: { cursor: ActivityPosition; direction: "older" | "newer" } | null,
): SQL[] {
  const e = sql.raw("activity_events");
  const conds: SQL[] = [sql`${e}.project_id = ${window.projectId}`];
  if (window.from) conds.push(sql`${e}.occurred_at >= ${window.from.toISOString()}::timestamptz`);
  if (window.to) conds.push(sql`${e}.occurred_at < ${window.to.toISOString()}::timestamptz`);
  if (q.outcomes) conds.push(sql`${e}.outcome = ANY(${sql.param([...q.outcomes])}::activity_outcome[])`);
  if (q.platform) conds.push(sql`${e}.provider_keys @> ARRAY[${q.platform}]::text[]`);
  if (q.accountId) conds.push(sql`${e}.social_account_id = ${q.accountId}`);
  if (position) {
    const op = sql.raw(position.direction === "older" ? "<" : ">");
    conds.push(
      sql`(${e}.occurred_at, ${e}.seq) ${op} (${position.cursor.occurredAt.toISOString()}::timestamptz, ${position.cursor.seq}::bigint)`,
    );
  }
  return conds;
}

function joinConds(conds: SQL[]): SQL {
  return sql.join(conds, sql` AND `);
}

/** All-projects reads re-check membership in the same statement, so a removal mid-request still hides the project. */
function memberJoin(userId: string | null): SQL {
  return userId
    ? sql`JOIN member ON member.organization_id = activity_events.project_id AND member.user_id = ${userId}`
    : sql``;
}

/**
 * One project's newest (or oldest) `limit + 1` events. The events are read straight off the
 * (project_id, occurred_at, seq) index with no joins, so the scan stops after `limit + 1` rows; the display joins
 * then run over those rows only. Every joined table is pinned to the window's project id through `projects.id`.
 */
function listBranch(
  window: BranchQuery["windows"][number],
  q: BranchQuery,
  position: { cursor: ActivityPosition; direction: "older" | "newer" } | null,
  direction: "older" | "newer",
  limit: number,
  memberUserId: string | null,
): SQL {
  const order = sql.raw(direction === "older" ? "DESC" : "ASC");
  const pid = window.projectId;
  return sql`(SELECT
      ev.id AS id,
      ev.seq::text AS seq,
      ev.project_id AS project_id,
      ev.occurred_at AS occurred_at,
      ${iso("ev.occurred_at")} AS occurred_iso,
      ev.kind::text AS kind,
      ev.outcome::text AS outcome,
      ev.post_id AS post_id,
      ev.post_target_id AS post_target_id,
      ev.social_account_id AS social_account_id,
      ev.provider_key AS provider_key,
      ev.provider_keys AS provider_keys,
      ev.group_key AS group_key,
      ev.actor_user_id AS actor_user_id,
      ev.actor_api_key_id AS actor_api_key_id,
      ev.message AS message,
      ev.details AS details,
      projects.slug AS project_slug,
      projects.name AS project_name,
      projects.timezone AS project_time_zone,
      social_accounts.display_name AS account_name,
      ${iso("social_accounts.removed_at")} AS account_removed_iso,
      ${iso("posts.deleted_at")} AS post_deleted_iso,
      coalesce(post_targets.override_text, posts.base_text) AS post_text,
      post_targets.status::text AS target_status
    FROM (
      SELECT activity_events.* FROM activity_events
      ${memberJoin(memberUserId)}
      WHERE ${joinConds(branchConditions(window, q, position))}
      ORDER BY activity_events.occurred_at ${order}, activity_events.seq ${order}
      LIMIT ${limit + 1}
    ) AS ev
    JOIN projects ON projects.id = ev.project_id
    LEFT JOIN posts ON posts.project_id = projects.id AND posts.id = ev.post_id
    LEFT JOIN post_targets ON post_targets.project_id = projects.id AND post_targets.id = ev.post_target_id
    LEFT JOIN social_accounts ON social_accounts.project_id = projects.id AND social_accounts.id = ev.social_account_id
    WHERE projects.id = ${pid}
    ORDER BY ev.occurred_at ${order}, ev.seq ${order})`;
}

type Row = Record<string, unknown>;

function toRecord(r: Row): ActivityRecord {
  return {
    id: r.id as string,
    seq: r.seq as string,
    projectId: r.project_id as string,
    occurredAt: new Date(r.occurred_iso as string),
    kind: r.kind as ActivityKind,
    outcome: r.outcome as ActivityOutcome,
    postId: (r.post_id as string | null) ?? null,
    postTargetId: (r.post_target_id as string | null) ?? null,
    socialAccountId: (r.social_account_id as string | null) ?? null,
    providerKey: (r.provider_key as string | null) ?? null,
    providerKeys: r.provider_keys as string[],
    groupKey: (r.group_key as string | null) ?? null,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorApiKeyId: (r.actor_api_key_id as string | null) ?? null,
    message: r.message as string,
    details: (r.details ?? {}) as Record<string, unknown>,
    projectSlug: r.project_slug as string,
    projectName: r.project_name as string,
    projectTimeZone: r.project_time_zone as string,
    accountName: (r.account_name as string | null) ?? null,
    accountRemovedAt: toDate(r.account_removed_iso),
    postDeletedAt: toDate(r.post_deleted_iso),
    postText: (r.post_text as string | null) ?? null,
    targetStatus: (r.target_status as string | null) ?? null,
  };
}

function rowsOf(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

/** The read side over a fixed set of projects: every window must name one of them, or the call throws before any SQL runs. */
export function createActivityReader(
  db: Database,
  allowedProjectIds: readonly string[],
  opts: { memberUserId?: string } = {},
): Pick<ActivityRepo, "list" | "summary"> {
  const memberUserId = opts.memberUserId ?? null;
  const allowed = new Set(allowedProjectIds);
  function check(q: BranchQuery): void {
    for (const w of q.windows) {
      if (!allowed.has(w.projectId)) throw new Error("Activity window names a project outside this scope");
    }
  }
  return {
    async list(q) {
      check(q);
      if (q.windows.length === 0) return [];
      const position = q.cursor ? { cursor: q.cursor, direction: q.direction } : null;
      const branches = q.windows.map((w) => listBranch(w, q, position, q.direction, q.limit, memberUserId));
      const order = sql.raw(q.direction === "older" ? "DESC" : "ASC");
      const query = sql`SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS activity_page ORDER BY occurred_at ${order}, seq::bigint ${order} LIMIT ${q.limit + 1}`;
      const rows = rowsOf(await db.execute(query)).map(toRecord);
      // Always newest first, whichever way the page was read.
      return q.direction === "newer" ? rows.reverse() : rows;
    },
    async summary(q) {
      check(q);
      let successes = 0;
      let problems = 0;
      if (q.windows.length === 0) return { successes, problems };
      // One round trip: each window counts on its own (project-led) index, and the branches are summed.
      const branches = q.windows.map(
        (w) => sql`SELECT activity_events.outcome::text AS outcome, count(*)::int AS n
          FROM activity_events
          ${memberJoin(memberUserId)}
          WHERE ${joinConds(branchConditions(w, q, null))}
          GROUP BY activity_events.outcome`,
      );
      const query = sql`SELECT outcome, sum(n)::int AS n FROM (${sql.join(branches, sql` UNION ALL `)}) AS activity_counts GROUP BY outcome`;
      for (const r of rowsOf(await db.execute(query))) {
        const outcome = r.outcome as ActivityOutcome;
        const n = Number(r.n);
        if (SUCCESS_OUTCOMES.includes(outcome)) successes += n;
        else if (PROBLEM_OUTCOMES.includes(outcome)) problems += n;
      }
      return { successes, problems };
    },
  };
}

export function createActivityRepo(db: Database, projectId: string): ActivityRepo {
  return {
    ...createActivityReader(db, [projectId]),
    async insert(event) {
      const details = activityDetailsSchema(event.kind).parse(event.details);
      const message = clipMessage(event.message);
      if (message.length === 0) throw new Error("An activity event needs a message");
      const providerKeys = event.providerKeys ?? (event.providerKey ? [event.providerKey] : []);
      const [row] = await db
        .insert(activityEvents)
        .values({
          projectId,
          occurredAt: new Date(Math.floor(event.occurredAt.getTime())),
          kind: event.kind,
          outcome: KIND_OUTCOME[event.kind],
          postId: event.postId ?? null,
          postTargetId: event.postTargetId ?? null,
          socialAccountId: event.socialAccountId ?? null,
          providerKey: event.providerKey,
          providerKeys: [...providerKeys],
          groupKey: event.groupKey ?? null,
          actorUserId: event.actorUserId ?? null,
          actorApiKeyId: event.actorApiKeyId ?? null,
          message,
          details,
        })
        .returning({ id: activityEvents.id });
      return { id: row!.id };
    },
  };
}
