import { findProvider, listProviders } from "../../../providers/registry";
import { activityActorLabel, type ActivityActor } from "../../../lib/activity/text";
import type { ActivityKind, ActivityOutcome } from "../../../lib/activity/outcomes";
import type { ActivityRecord, ActivityRepo, BranchQuery } from "../../dal/activity";
import * as clock from "../../dal/clock";
import { ForbiddenError, ValidationIssuesError } from "../../dal/errors";
import { Temporal } from "@js-temporal/polyfill";
import type { ApiActivityPage, ApiActivityQuery } from "../../../lib/api/schemas";
import type { ProjectSetScope } from "../../dal/my-projects";
import type { ProjectScope } from "../../dal/scope";
import { getEnv } from "../../env";
import { excerptOf } from "../posts/list";
import { decodeActivityCursor, encodeActivityCursor, type ActivityCursor } from "./cursor";
import { parseActivityFilter, summaryLabel, windowFor, type ActivityFilter, type RawParams } from "./filters";
import { activityLink, type ActivityLink } from "./links";

export const ACTIVITY_PAGE_SIZE = 50;

export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  outcome: ActivityOutcome;
  occurredAt: Date;
  message: string;
  details: Record<string, unknown>;
  project: { id: string; slug: string; name: string; timeZone: string };
  platform: { key: string; name: string } | null;
  platforms: { key: string; name: string }[];
  account: { id: string; name: string; removed: boolean } | null;
  post: { id: string; excerpt: string; deleted: boolean } | null;
  target: { id: string; currentStatus: string | null } | null;
  actor: ActivityActor;
  actorLabel: string;
  link: ActivityLink | null;
}

export interface ActivitySummary {
  successes: number;
  problems: number;
  label: string;
}

export interface ActivityPage {
  rows: ActivityRow[];
  summary: ActivitySummary;
  filter: ActivityFilter;
  /** `from` is after `to`: no rows, zero counts, an inline message. */
  invalidRange: boolean;
  newer: string | null;
  older: string | null;
  accounts: { id: string; name: string; providerKey: string }[];
  platforms: { key: string; name: string }[];
  projects?: { slug: string; name: string }[];
}

export type ActorLookup = {
  member(userId: string): string | null;
  apiKey(keyId: string): string | null;
};

export function platformName(key: string): string {
  return findProvider(key)?.displayName ?? key;
}

export function knownPlatformKeys(): string[] {
  return listProviders().map((p) => p.key);
}

/** The platforms a person can filter by: the registered ones, `mock` only while it is enabled. */
export function platformOptions(): { key: string; name: string }[] {
  const mockOn = getEnv().MOCK_PROVIDER_ENABLED;
  return listProviders()
    .filter((p) => p.key !== "mock" || mockOn)
    .map((p) => ({ key: p.key, name: p.displayName }));
}

/** Maps a stored record to the read model, resolving the actor with the caller's lookups. */
export function toActivityRow(r: ActivityRecord, actors: ActorLookup): ActivityRow {
  const actor: ActivityActor = r.actorApiKeyId
    ? { kind: "api_key", name: actors.apiKey(r.actorApiKeyId) }
    : r.actorUserId
      ? { kind: "member", name: actors.member(r.actorUserId) }
      : { kind: "scheduler" };
  const platforms = r.providerKeys.map((key) => ({ key, name: platformName(key) }));
  const postDeleted = r.postId !== null && (r.postDeletedAt !== null || r.postText === null);
  return {
    id: r.id,
    kind: r.kind,
    outcome: r.outcome,
    occurredAt: r.occurredAt,
    message: r.message,
    details: r.details,
    project: { id: r.projectId, slug: r.projectSlug, name: r.projectName, timeZone: r.projectTimeZone },
    platform: r.providerKey ? { key: r.providerKey, name: platformName(r.providerKey) } : null,
    platforms,
    account: r.socialAccountId
      ? {
          id: r.socialAccountId,
          name: r.accountName !== null && r.accountRemovedAt === null ? r.accountName : "Removed account",
          removed: r.accountName === null || r.accountRemovedAt !== null,
        }
      : null,
    post: r.postId ? { id: r.postId, excerpt: r.postText ? excerptOf(r.postText) : "", deleted: postDeleted } : null,
    target: r.postTargetId ? { id: r.postTargetId, currentStatus: r.targetStatus } : null,
    actor,
    actorLabel: activityActorLabel(actor),
    link: activityLink(
      { kind: r.kind, outcome: r.outcome, postId: r.postId, postTargetId: r.postTargetId, postDeleted, targetStatus: r.targetStatus },
      r.projectSlug,
    ),
  };
}

const pickPosition = (r: ActivityRecord, d: ActivityCursor["d"]): string =>
  encodeActivityCursor({ t: r.occurredAt.toISOString(), s: r.seq, d });

/** One page over any set of windows: the single implementation behind the project and all-projects screens. */
export async function readPage(
  repo: Pick<ActivityRepo, "list" | "summary">,
  input: {
    filter: ActivityFilter;
    windows: BranchQuery["windows"];
    cursor: ActivityCursor | null;
    limit: number;
  },
): Promise<{ records: ActivityRecord[]; summary: { successes: number; problems: number }; newer: string | null; older: string | null }> {
  const { filter, windows, limit } = input;
  const outcomes = filter.outcomes ? [...filter.outcomes] : null;
  const shared = { windows, outcomes, platform: filter.platform, accountId: filter.accountId };
  // The counts ignore only the outcome part of the filter (research P13).
  const summary = await repo.summary({ ...shared, outcomes: null });
  const fetch = (cursor: ActivityCursor | null) =>
    repo.list({
      ...shared,
      cursor: cursor ? { occurredAt: new Date(cursor.t), seq: cursor.s } : null,
      direction: cursor?.d ?? "older",
      limit,
    });

  let cursor = input.cursor;
  let fetched = await fetch(cursor);
  if (cursor?.d === "newer" && fetched.length === 0) {
    cursor = null; // nothing above that position any more: the first page
    fetched = await fetch(null);
  }
  const direction = cursor?.d ?? "older";
  let records: ActivityRecord[];
  let newer: string | null = null;
  let older: string | null = null;
  if (direction === "older") {
    const more = fetched.length > limit;
    records = fetched.slice(0, limit);
    if (more) older = pickPosition(records[records.length - 1]!, "older");
    if (cursor && records.length > 0) newer = pickPosition(records[0]!, "newer");
  } else {
    const more = fetched.length > limit;
    records = more ? fetched.slice(1) : fetched; // newest first: the extra row is the first
    if (more) newer = pickPosition(records[0]!, "newer");
    if (records.length > 0) older = pickPosition(records[records.length - 1]!, "older");
  }
  return { records, summary, newer, older };
}

function need(scope: ProjectScope): void {
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
}

async function actorLookup(scope: ProjectScope, records: readonly ActivityRecord[]): Promise<ActorLookup> {
  const members = new Map<string, string>();
  if (records.some((r) => r.actorUserId && !r.actorApiKeyId)) for (const m of await scope.members.list()) members.set(m.userId, m.name);
  const keys = new Map<string, string | null>();
  for (const id of new Set(records.flatMap((r) => (r.actorApiKeyId ? [r.actorApiKeyId] : [])))) {
    keys.set(id, (await scope.apiKeys.get(id))?.name ?? null);
  }
  return { member: (id) => members.get(id) ?? null, apiKey: (id) => keys.get(id) ?? null };
}

/** Throws ForbiddenError without `post: view`. Lenient filter; a malformed cursor means the first page. */
export async function listProjectActivity(scope: ProjectScope, raw: RawParams): Promise<ActivityPage> {
  need(scope);
  const { filter } = parseActivityFilter(raw, { mode: "lenient", knownPlatforms: knownPlatformKeys() });
  const cursorParam = Array.isArray(raw.cursor) ? raw.cursor[0] : raw.cursor;
  const cursor = decodeActivityCursor(cursorParam);
  const accounts = (await scope.accounts.list())
    .filter((a) => a.removedAt === null)
    .map((a) => ({ id: a.id, name: a.displayName, providerKey: a.providerKey }));
  const base = { filter, invalidRange: filter.invalidRange, accounts, platforms: platformOptions() };
  const label = summaryLabel(filter);
  if (filter.invalidRange) {
    return { ...base, rows: [], summary: { successes: 0, problems: 0, label }, newer: null, older: null };
  }
  const now = await clock.now();
  const window = windowFor(filter, scope.project.timezone, now);
  const page = await readPage(scope.activity, {
    filter,
    windows: [{ projectId: scope.project.id, ...window }],
    cursor,
    limit: ACTIVITY_PAGE_SIZE,
  });
  const actors = await actorLookup(scope, page.records);
  return {
    ...base,
    rows: page.records.map((r) => toActivityRow(r, actors)),
    summary: { ...page.summary, label },
    newer: page.newer,
    older: page.older,
  };
}

/** The caller's projects only; a `project` slug outside them matches nothing. Each project's days use its own zone. */
export async function listMyActivity(set: ProjectSetScope, raw: RawParams): Promise<ActivityPage> {
  const { filter } = parseActivityFilter(raw, { mode: "lenient", allowProjects: true, knownPlatforms: knownPlatformKeys() });
  const cursor = decodeActivityCursor(Array.isArray(raw.cursor) ? raw.cursor[0] : raw.cursor);
  const base = {
    filter,
    invalidRange: filter.invalidRange,
    accounts: [],
    platforms: platformOptions(),
    projects: set.projects.map((p) => ({ slug: p.slug, name: p.name })),
  };
  const label = summaryLabel(filter);
  const chosen = filter.projectSlugs ? set.projects.filter((p) => filter.projectSlugs!.includes(p.slug)) : set.projects;
  if (filter.invalidRange || chosen.length === 0) {
    return { ...base, rows: [], summary: { successes: 0, problems: 0, label }, newer: null, older: null };
  }
  const now = await clock.now();
  const page = await readPage(set.activity, {
    filter,
    windows: chosen.map((p) => ({ projectId: p.id, ...windowFor(filter, p.timeZone, now) })),
    cursor,
    limit: ACTIVITY_PAGE_SIZE,
  });
  // Names for the page's actors, looked up once per project or key and in parallel (up to one per project).
  const memberProjects = [...new Set(page.records.filter((r) => r.actorUserId && !r.actorApiKeyId).map((r) => r.projectId))];
  const keyRefs = [...new Map(page.records.filter((r) => r.actorApiKeyId).map((r) => [r.actorApiKeyId!, r.projectId] as const))];
  const [memberLists, keyNames] = await Promise.all([
    Promise.all(memberProjects.map((projectId) => set.memberNames(projectId))),
    Promise.all(keyRefs.map(([keyId, projectId]) => set.apiKeyName(projectId, keyId))),
  ]);
  const members = new Map(memberProjects.map((projectId, i) => [projectId, memberLists[i]!]));
  const keys = new Map(keyRefs.map(([keyId], i) => [keyId, keyNames[i] ?? null]));
  return {
    ...base,
    rows: page.records.map((r) =>
      toActivityRow(r, {
        member: (id) => members.get(r.projectId)?.get(id) ?? null,
        apiKey: (id) => keys.get(id) ?? null,
      }),
    ),
    summary: { ...page.summary, label },
    newer: page.newer,
    older: page.older,
  };
}

/** The strict, newest-first page for the API. Every bad filter field is reported together as a 400. */
export async function listActivityForApi(scope: ProjectScope, query: ApiActivityQuery): Promise<ApiActivityPage> {
  need(scope);
  const { filter, issues } = parseActivityFilter(
    { outcome: query.outcome, platform: query.platform, account: query.account, from: query.from, to: query.to, range: query.range },
    { mode: "strict", knownPlatforms: knownPlatformKeys() },
  );
  const problems: { code: string; field: string; message: string }[] = issues.map((i) => ({ code: "invalid_value", field: i.field, message: i.message }));
  let cursor: ActivityCursor | null = null;
  if (query.cursor !== undefined) {
    cursor = decodeActivityCursor(query.cursor);
    if (!cursor || cursor.d !== "older") problems.push({ code: "invalid_value", field: "cursor", message: "The cursor is not valid." });
  }
  if (problems.length > 0) throw new ValidationIssuesError(problems, "The request is not valid.");

  const now = await clock.now();
  const window = windowFor(filter, scope.project.timezone, now);
  const page = await readPage(scope.activity, {
    filter,
    windows: [{ projectId: scope.project.id, ...window }],
    cursor,
    limit: query.limit,
  });
  const actors = await actorLookup(scope, page.records);
  const zone = scope.project.timezone;
  const data = page.records.map((r) => {
    const row = toActivityRow(r, actors);
    return {
      id: row.id,
      kind: row.kind,
      outcome: row.outcome,
      occurredAt: row.occurredAt.toISOString(),
      occurredAtLocal: Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime()).toZonedDateTimeISO(zone).toString(),
      platform: row.platform?.key ?? null,
      platforms: row.platforms.map((p) => p.key),
      account: row.account,
      post: row.post && row.target ? { id: row.post.id, targetId: row.target.id, excerpt: row.post.excerpt, deleted: row.post.deleted } : null,
      message: row.message,
      actor: { type: row.actor.kind === "api_key" ? ("api_key" as const) : row.actor.kind, name: row.actorLabel },
      details: row.details,
    };
  });
  return { data, nextCursor: page.older };
}
