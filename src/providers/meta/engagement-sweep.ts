import type { EngagementReadContext, EngagementReadResult, InboundItemDraft } from "../types";
import { graphVersion, metaUsageCeiling } from "./config";
import { readPageToken } from "./credentials";
import { classifyEngagementOutcome } from "./engagement-errors";
import { mapMetaComment, metaCommentTimeMs, type MetaCommentSurface, type MetaSelfIdentity } from "./engagement-map";
import { parseEngagementState, shrinkEngagementState, type MetaEngagementState } from "./engagement-state";
import { DEFAULT_GRAPH_BASE, graphRequest, type GraphOutcome, type MetaApp } from "./graph";
import { activeUsageBackoff, recordUsageBackoff, type UsageSignal } from "./usage";

/** contracts/meta-engagement-sweep.md §3. */
const POSTS_PER_PAGE = 5;
const MAX_PENDING = 3;
/** Graph's generic "object does not exist" code (`facebook/insights.ts`'s `GONE_CODE`). */
const GONE_CODE = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function commentsPerPostInline(limit: number): number {
  return clamp(Math.floor(limit / POSTS_PER_PAGE), 1, 10);
}

function commentsPerDrainPage(limit: number): number {
  return Math.min(limit, 50);
}

interface ListedPost {
  id: string;
  comments?: { data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown } };
  [key: string]: unknown;
}

interface ListingPage {
  posts: ListedPost[];
  after: string | null;
  hasNext: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseListingBody(body: unknown): ListingPage {
  const root = asRecord(body);
  const data = Array.isArray(root?.data) ? (root!.data as unknown[]) : [];
  const posts = data.filter((d): d is ListedPost => asRecord(d) !== null && typeof (d as Record<string, unknown>).id === "string") as ListedPost[];
  const paging = asRecord(root?.paging);
  const cursors = asRecord(paging?.cursors);
  const after = typeof cursors?.after === "string" ? cursors.after : null;
  const hasNext = typeof paging?.next === "string";
  return { posts, after, hasNext };
}

function inlineComments(post: ListedPost): { comments: Record<string, unknown>[]; after: string | null } {
  const block = asRecord(post.comments);
  const data = Array.isArray(block?.data) ? (block!.data as unknown[]) : [];
  const comments = data.filter((d): d is Record<string, unknown> => asRecord(d) !== null) as Record<string, unknown>[];
  const cursors = asRecord(block?.paging ? asRecord(block.paging)?.cursors : null);
  const after = typeof cursors?.after === "string" ? cursors.after : null;
  return { comments, after };
}

function parseCommentsPageBody(body: unknown): { comments: Record<string, unknown>[]; after: string | null } {
  const root = asRecord(body);
  const data = Array.isArray(root?.data) ? (root!.data as unknown[]) : [];
  const comments = data.filter((d): d is Record<string, unknown> => asRecord(d) !== null) as Record<string, unknown>[];
  const paging = asRecord(root?.paging);
  const cursors = asRecord(paging?.cursors);
  const after = typeof cursors?.after === "string" ? cursors.after : null;
  return { comments, after };
}

/** Appends `postId`/`after` to `pending` (capped at MAX_PENDING, duplicates by postId ignored). */
function enqueuePending(pending: MetaEngagementState["pending"], postId: string, after: string): MetaEngagementState["pending"] {
  const list = pending ? [...pending] : [];
  if (list.some((p) => p.postId === postId)) return list;
  if (list.length >= MAX_PENDING) return list;
  return [...list, { postId, after }];
}

/** contracts/meta-usage.md §3 pattern, reused from `facebook/insights.ts`'s `applyUsageSignal`. */
function applyUsageSignal(accountId: string, outcome: GraphOutcome, now: Date): void {
  const usage: UsageSignal | undefined = outcome.kind === "network" ? undefined : outcome.usage;
  if (!usage || usage.maxPercent < metaUsageCeiling() || usage.retryAfterMinutes === null) return;
  recordUsageBackoff(accountId, new Date(now.getTime() + usage.retryAfterMinutes * 60_000));
}

type Step = "drain" | "catchUp" | "fresh";

function chooseStep(state: MetaEngagementState, direction: "newest" | "older"): Step {
  if (state.pending && state.pending.length > 0) return "drain";
  if (direction === "older" && !state.done) return "catchUp";
  if (state.lastStep === "fresh" && !state.done) return "catchUp";
  return "fresh";
}

/**
 * contracts/meta-engagement-sweep.md §1, §3, §4. One shared walk over a brand's own posts, called
 * by both Facebook's and Instagram's `MetaCommentSurface` declarations. Exactly one Graph call per
 * `read()` (plus Instagram's once-ever `prefetchSelf`).
 */
export async function metaEngagementRead(surface: MetaCommentSurface, ctx: EngagementReadContext<unknown>): Promise<EngagementReadResult> {
  const backoff = activeUsageBackoff(ctx.account.id, ctx.now);
  if (backoff) return { kind: "rate_limited", error: `${surface.platform} reports this account is near its call budget.`, retryAt: backoff };

  const token = readPageToken(ctx.account.credentials);
  if (!token) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };

  let state: MetaEngagementState = { ...parseEngagementState(ctx.providerState), v: 1 };
  const secrets = [token];
  const app: MetaApp = { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };

  if (surface.prefetchSelf && !state.selfUsername) {
    const result = await surface.prefetchSelf({ accountExternalId: ctx.account.externalId, token, signal: ctx.signal });
    if (result.kind !== "ok") return classifyEngagementOutcome(result, { platform: surface.platform, secrets, hasCursor: false });
    state = { ...state, selfUsername: result.selfUsername };
  }

  const identity: MetaSelfIdentity = { externalId: ctx.account.externalId, selfUsername: state.selfUsername ?? null };
  const step = chooseStep(state, ctx.direction);

  if (step === "drain") return runDrain(surface, ctx, state, identity, app, token, secrets);
  if (step === "catchUp") return runCatchUp(surface, ctx, state, identity, app, token, secrets);
  return runFresh(surface, ctx, state, identity, app, token, secrets);
}

async function runFresh(
  surface: MetaCommentSurface,
  ctx: EngagementReadContext<unknown>,
  state: MetaEngagementState,
  identity: MetaSelfIdentity,
  app: MetaApp,
  token: string,
  secrets: readonly string[],
): Promise<EngagementReadResult> {
  const inlineLimit = commentsPerPostInline(ctx.limit);
  const outcome = await graphRequest(app, {
    method: "GET",
    path: surface.ownPostsPath(ctx.account.externalId),
    params: {
      fields: `id,${surface.postTimeField},comments.limit(${inlineLimit}){${surface.commentFields.join(",")}}`,
      limit: String(POSTS_PER_PAGE),
    },
    token,
    signal: ctx.signal,
  });
  applyUsageSignal(ctx.account.id, outcome, ctx.now);
  if (outcome.kind !== "ok") return classifyEngagementOutcome(outcome, { platform: surface.platform, secrets, hasCursor: false });

  const { posts } = parseListingBody(outcome.body);
  const items: InboundItemDraft[] = [];
  let freshSince = state.freshSince ?? 0;
  let pending = state.pending;

  for (const post of posts) {
    const { comments, after } = inlineComments(post);
    for (const comment of comments) {
      if (surface.isSelf(comment, identity)) continue;
      const time = metaCommentTimeMs(surface, comment);
      if (time === null || time <= freshSince) continue;
      const draft = mapMetaComment(surface, comment, post.id, identity);
      if (!draft) continue;
      items.push(draft);
      if (time > freshSince) freshSince = time;
    }
    if (after !== null) pending = enqueuePending(pending, post.id, after);
  }

  const nextState = shrinkEngagementState({
    ...state,
    freshSince,
    ...(pending && pending.length > 0 ? { pending } : {}),
    lastStep: "fresh",
  });

  return {
    kind: "page",
    items,
    cursor: null,
    providerState: nextState,
    exhausted: false,
    summary: { response: { count: items.length } },
  };
}

async function runCatchUp(
  surface: MetaCommentSurface,
  ctx: EngagementReadContext<unknown>,
  state: MetaEngagementState,
  identity: MetaSelfIdentity,
  app: MetaApp,
  token: string,
  secrets: readonly string[],
): Promise<EngagementReadResult> {
  const inlineLimit = commentsPerPostInline(ctx.limit);
  const postsAfter = state.catchUp?.postsAfter;
  const outcome = await graphRequest(app, {
    method: "GET",
    path: surface.ownPostsPath(ctx.account.externalId),
    params: {
      fields: `id,${surface.postTimeField},comments.limit(${inlineLimit}){${surface.commentFields.join(",")}}`,
      limit: String(POSTS_PER_PAGE),
      ...(postsAfter ? { after: postsAfter } : {}),
    },
    token,
    signal: ctx.signal,
  });
  applyUsageSignal(ctx.account.id, outcome, ctx.now);
  if (outcome.kind !== "ok") return classifyEngagementOutcome(outcome, { platform: surface.platform, secrets, hasCursor: Boolean(postsAfter) });

  const { posts, after, hasNext } = parseListingBody(outcome.body);
  const items: InboundItemDraft[] = [];
  let pending = state.pending;

  for (const post of posts) {
    const { comments, after: commentsAfter } = inlineComments(post);
    for (const comment of comments) {
      if (surface.isSelf(comment, identity)) continue;
      const draft = mapMetaComment(surface, comment, post.id, identity);
      if (draft) items.push(draft);
    }
    if (commentsAfter !== null) pending = enqueuePending(pending, post.id, commentsAfter);
  }

  const listingExhausted = !hasNext || !after;
  const done = listingExhausted && (!pending || pending.length === 0);

  const nextState = shrinkEngagementState({
    ...state,
    ...(pending && pending.length > 0 ? { pending } : {}),
    catchUp: { postsAfter: after ?? undefined },
    lastStep: "catchUp",
    ...(done ? { done: true as const } : {}),
  });

  return {
    kind: "page",
    items,
    cursor: null,
    providerState: nextState,
    exhausted: done,
    summary: { response: { count: items.length } },
  };
}

async function runDrain(
  surface: MetaCommentSurface,
  ctx: EngagementReadContext<unknown>,
  state: MetaEngagementState,
  identity: MetaSelfIdentity,
  app: MetaApp,
  token: string,
  secrets: readonly string[],
): Promise<EngagementReadResult> {
  const entry = state.pending![0]!;
  const outcome = await graphRequest(app, {
    method: "GET",
    path: `/${entry.postId}/comments`,
    params: {
      limit: String(commentsPerDrainPage(ctx.limit)),
      ...surface.drainParams,
      ...(entry.after ? { after: entry.after } : {}),
    },
    token,
    signal: ctx.signal,
  });
  applyUsageSignal(ctx.account.id, outcome, ctx.now);

  if (outcome.kind !== "ok") {
    // A Graph error naming this post gone is not an account-level failure (FR-017): the entry is
    // dropped and the read returns an empty, successful page rather than failing.
    if (outcome.kind === "graph_error" && outcome.error.code === GONE_CODE) {
      const pending = state.pending!.slice(1);
      const nextState = shrinkEngagementState({ ...state, ...(pending.length > 0 ? { pending } : { pending: undefined }) });
      return { kind: "page", items: [], cursor: null, providerState: nextState, exhausted: false, summary: { response: { count: 0 } } };
    }
    return classifyEngagementOutcome(outcome, { platform: surface.platform, secrets, hasCursor: Boolean(entry.after) });
  }

  const { comments, after } = parseCommentsPageBody(outcome.body);
  const items: InboundItemDraft[] = [];
  for (const comment of comments) {
    if (surface.isSelf(comment, identity)) continue;
    const draft = mapMetaComment(surface, comment, entry.postId, identity);
    if (draft) items.push(draft);
  }

  const rest = state.pending!.slice(1);
  const pending = after !== null ? [{ postId: entry.postId, after }, ...rest] : rest;
  const nextState = shrinkEngagementState({ ...state, ...(pending.length > 0 ? { pending } : { pending: undefined }) });

  return {
    kind: "page",
    items,
    cursor: null,
    providerState: nextState,
    exhausted: false,
    summary: { response: { count: items.length } },
  };
}
