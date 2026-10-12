import { sql, type SQL } from "drizzle-orm";
import { PROBLEM_OUTCOMES, SUCCESS_OUTCOMES, KIND_OUTCOME, type ActivityKind, type ActivityOutcome } from "../../lib/activity/outcomes";
import { activityDetailsSchema, type ActivityDetails } from "../../lib/activity/details";
import { CONNECT_FAILED, isAttentionOutcome } from "../../lib/notifications/attention";
import type { EligibilityPlan } from "../../lib/notifications/eligibility";
import { clipMessage } from "../../lib/activity/text";
import type { Database } from "../db/client";
import { activityEvents, notificationChangeMarker } from "../db/schema";
import { platformClauseSql } from "./notifications";

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

/**
 * An equality outcome or an outcome group (and optionally the actor and the eligibility floor) for one
 * branch; the literals come from the attention constants, never from input.
 */
interface BranchExtra {
  outcomeEq?: ActivityOutcome;
  outcomesIn?: readonly string[];
  actorEq?: string;
  /** Omitted when 0 (data-model.md §4.4). */
  minSeq?: bigint;
  /** The platform clause of data-model.md §4.3, applied to this branch's own alias. */
  platformClause?: SQL;
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
  extra: BranchExtra | null = null,
): SQL[] {
  const e = sql.raw("activity_events");
  const conds: SQL[] = [sql`${e}.project_id = ${window.projectId}`];
  if (window.from) conds.push(sql`${e}.occurred_at >= ${window.from.toISOString()}::timestamptz`);
  if (window.to) conds.push(sql`${e}.occurred_at < ${window.to.toISOString()}::timestamptz`);
  if (q.outcomes) conds.push(sql`${e}.outcome = ANY(${sql.param([...q.outcomes])}::activity_outcome[])`);
  if (extra) {
    if (extra.outcomeEq) conds.push(sql`${e}.outcome = ${sql.raw(`'${extra.outcomeEq}'`)}`);
    if (extra.outcomesIn) conds.push(sql`${e}.outcome IN (${sql.raw(extra.outcomesIn.map((o) => `'${o}'`).join(", "))})`);
    if (extra.actorEq) conds.push(sql`${e}.actor_user_id = ${extra.actorEq}`);
    if (extra.minSeq && extra.minSeq > 0n) conds.push(sql`${e}.seq > ${extra.minSeq.toString()}::bigint`);
  }
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
  extra: BranchExtra | null = null,
  marks: { userId: string; exclude: "snoozed" | "hidden" } | null = null,
): SQL {
  const order = sql.raw(direction === "older" ? "DESC" : "ASC");
  const pid = window.projectId;
  // The two anti-joins live inside the inner subquery, before LIMIT, so excluding a live snooze (or,
  // for email, anything hidden now) still leaves `limit` rows after the exclusion (data-model.md §4.5,
  // M16; data-model.md §6.1, E15).
  const marksJoin = marks
    ? sql`LEFT JOIN notification_event_marks snoozed
            ON snoozed.project_id = activity_events.project_id
           AND snoozed.user_id = ${marks.userId}
           AND snoozed.event_id = activity_events.id
           AND snoozed.counts_again_at > now() AND snoozed.counts_again_at < 'infinity'::timestamptz
          LEFT JOIN notification_event_marks hidden
            ON hidden.project_id = activity_events.project_id
           AND hidden.user_id = ${marks.userId}
           AND hidden.event_id = activity_events.id
           AND hidden.counts_again_at > now()`
    : sql``;
  const marksFilter = marks
    ? marks.exclude === "hidden"
      ? sql`AND hidden.event_id IS NULL`
      : sql`AND snoozed.event_id IS NULL`
    : sql``;
  // "hidden" excludes outright, so hidden_by_mark is always false there and is not selected.
  const marksSelect = marks && marks.exclude === "snoozed" ? sql`, (hidden.event_id IS NOT NULL) AS hidden_by_mark` : sql``;
  const outerMarksSelect = marks && marks.exclude === "snoozed" ? sql`, ev.hidden_by_mark AS hidden_by_mark` : sql``;
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
      ${outerMarksSelect}
    FROM (
      SELECT activity_events.* ${marksSelect} FROM activity_events
      ${memberJoin(memberUserId)}
      ${marksJoin}
      WHERE ${joinConds(branchConditions(window, q, position, extra))} ${extra?.platformClause ?? sql``} ${marksFilter}
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

function toAttentionRecord(r: Row): AttentionRecord {
  return { ...toRecord(r), hiddenByMark: r.hidden_by_mark === true };
}

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

/** A panel row plus this person's mark state for it (data-model.md §4.5, M16). */
export type AttentionRecord = ActivityRecord & {
  /** A mark whose instant is still in the future: having excluded live snoozes, this means "read" (N20). */
  hiddenByMark: boolean;
};

/** The read side over a fixed set of projects: every window must name one of them, or the call throws before any SQL runs. */
export function createActivityReader(
  db: Database,
  allowedProjectIds: readonly string[],
  opts: { memberUserId?: string } = {},
): Pick<ActivityRepo, "list" | "summary"> & {
  /**
   * Attention events for `userId` (022): one branch per on member-outcome group plus one for
   * `connect_failed`, per project, newest first, up to `limit`, with currently-snoozed events excluded
   * and the caller's own read/snooze state on each row. Applies each project's compiled plan's minSeq
   * and platform clause, but not the floor — the panel lists read rows too (data-model.md §4.4, §4.5, M16).
   */
  listAttention(q: {
    projectIds: readonly string[];
    userId: string;
    limit: number;
    plans: ReadonlyMap<string, EligibilityPlan>;
  }): Promise<AttentionRecord[]>;
} {
  const memberUserId = opts.memberUserId ?? null;
  const allowed = new Set(allowedProjectIds);
  function check(q: BranchQuery): void {
    for (const w of q.windows) {
      if (!allowed.has(w.projectId)) throw new Error("Activity window names a project outside this scope");
    }
  }
  return {
    async listAttention(q) {
      for (const id of q.projectIds) {
        if (!allowed.has(id)) throw new Error("Activity window names a project outside this scope");
      }
      if (q.projectIds.length === 0) return [];
      const base = { outcomes: null, platform: null, accountId: null };
      const branches: SQL[] = [];
      for (const projectId of q.projectIds) {
        const plan = q.plans.get(projectId);
        if (!plan) continue;
        const bq: BranchQuery = { ...base, windows: [{ projectId, from: null, to: null }] };
        const window = bq.windows[0]!;
        const platformClause = platformClauseSql(plan.platforms, "activity_events.provider_keys", "activity_events.seq");
        for (const group of plan.memberGroups) {
          branches.push(
            listBranch(window, bq, null, "older", q.limit, memberUserId, { outcomesIn: group.outcomes, minSeq: group.minSeq, platformClause }, {
              userId: q.userId,
              exclude: "snoozed",
            }),
          );
        }
        if (plan.connectFailed) {
          branches.push(
            listBranch(
              window,
              bq,
              null,
              "older",
              q.limit,
              memberUserId,
              { outcomeEq: CONNECT_FAILED, actorEq: q.userId, minSeq: plan.connectFailed.minSeq, platformClause },
              { userId: q.userId, exclude: "snoozed" },
            ),
          );
        }
      }
      if (branches.length === 0) return [];
      const query = sql`SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS activity_attention ORDER BY occurred_at DESC, seq::bigint DESC LIMIT ${q.limit}`;
      return rowsOf(await db.execute(query)).map(toAttentionRecord);
    },
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

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * One branch per `plan.memberGroups` entry plus one for `connect_failed`, built on `listBranch` with
 * `marks: { userId, exclude: "hidden" }` — nothing hidden now is listed or counted (data-model.md §6.2,
 * E15). `minSeq` is the caller's own floor (the reading floor and the mailed-through position, already
 * maxed together); each branch raises it further by its own group threshold.
 */
function attentionForEmailBranches(
  q: { projectId: string; userId: string; plan: EligibilityPlan; minSeq: bigint },
  limit: number,
): SQL[] {
  const window: BranchQuery["windows"][number] = { projectId: q.projectId, from: null, to: null };
  const bq: BranchQuery = { windows: [window], outcomes: null, platform: null, accountId: null };
  const platformClause = platformClauseSql(q.plan.platforms, "activity_events.provider_keys", "activity_events.seq");
  const marks = { userId: q.userId, exclude: "hidden" as const };
  const branches: SQL[] = [];
  for (const group of q.plan.memberGroups) {
    const minSeq = maxBigint(group.minSeq, q.minSeq);
    branches.push(listBranch(window, bq, null, "older", limit, q.userId, { outcomesIn: group.outcomes, minSeq, platformClause }, marks));
  }
  if (q.plan.connectFailed) {
    const minSeq = maxBigint(q.plan.connectFailed.minSeq, q.minSeq);
    branches.push(
      listBranch(window, bq, null, "older", limit, q.userId, { outcomeEq: CONNECT_FAILED, actorEq: q.userId, minSeq, platformClause }, marks),
    );
  }
  return branches;
}

/** One project, one person: the newest `q.limit` eligible attention events above `q.minSeq`, nothing hidden now (data-model.md §6.2). */
export async function listAttentionForEmail(
  db: Database,
  q: { projectId: string; userId: string; limit: number; plan: EligibilityPlan; minSeq: bigint },
): Promise<AttentionRecord[]> {
  const branches = attentionForEmailBranches(q, q.limit);
  if (branches.length === 0) return [];
  const query = sql`SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS activity_email ORDER BY occurred_at DESC, seq::bigint DESC LIMIT ${q.limit}`;
  return rowsOf(await db.execute(query)).map(toAttentionRecord);
}

/** The same predicate, bounded: how many there are and the highest seq among them (data-model.md §6.2, E16). */
export async function countAttentionForEmail(
  db: Database,
  q: { projectId: string; userId: string; scanLimit: number; plan: EligibilityPlan; minSeq: bigint },
): Promise<{ total: number; maxSeq: bigint | null }> {
  const branches = attentionForEmailBranches(q, q.scanLimit);
  if (branches.length === 0) return { total: 0, maxSeq: null };
  const query = sql`SELECT count(*)::int AS total, max(seq::bigint) AS max_seq
    FROM (SELECT seq FROM (${sql.join(branches, sql` UNION ALL `)}) AS u LIMIT ${q.scanLimit}) AS bounded`;
  const row = rowsOf(await db.execute(query))[0];
  const maxSeq = row?.max_seq;
  return { total: Number(row?.total ?? 0), maxSeq: maxSeq === null || maxSeq === undefined ? null : BigInt(maxSeq as string) };
}

export function createActivityRepo(db: Database, projectId: string): ActivityRepo {
  const { list, summary } = createActivityReader(db, [projectId]);
  return {
    list,
    summary,
    async insert(event) {
      const details = activityDetailsSchema(event.kind).parse(event.details);
      const message = clipMessage(event.message);
      if (message.length === 0) throw new Error("An activity event needs a message");
      const providerKeys = event.providerKeys ?? (event.providerKey ? [event.providerKey] : []);
      // Writers take a shared lock on the project row before drawing `seq`, so marking read can wait them out (022 R3).
      await db.execute(sql`SELECT 1 FROM projects WHERE id = ${projectId} FOR KEY SHARE`);
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
      // The stream watcher's change marker (045): bumped in this same transaction, and only for an
      // attention outcome, so a post publishing successfully never touches the install-wide row.
      if (isAttentionOutcome(KIND_OUTCOME[event.kind])) {
        // An upsert, not an update: if the row were ever missing, a plain UPDATE would touch nothing and
        // change detection would stop silently, which is worse than any cost of the ON CONFLICT path.
        await db
          .insert(notificationChangeMarker)
          .values({ attentionWrites: 1n })
          .onConflictDoUpdate({
            target: notificationChangeMarker.id,
            set: { attentionWrites: sql`${notificationChangeMarker.attentionWrites} + 1`, updatedAt: new Date() },
          });
      }
      return { id: row!.id };
    },
  };
}
