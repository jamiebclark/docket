import type { GraphOutcome } from "./graph";
import type { InboundItemDraft } from "../types";

/** contracts/meta-comment-surface.md §1. Only the facts a Page and an Instagram account disagree about. */
export interface MetaCommentSurface {
  /** Prefixes every member-visible error, as `facebook/insights.ts`'s `PLATFORM` already does. */
  platform: "Facebook" | "Instagram";
  /** Graph path listing the brand's own posts. Takes the account's `externalId`. */
  ownPostsPath(accountExternalId: string): string;
  /** Field carrying a post's publication time on that listing. */
  postTimeField: string;
  /** Fields requested inside the nested `comments{…}` expansion. */
  commentFields: readonly string[];
  /** Field carrying a comment's words. "" when absent — never a placeholder (FR-031). */
  commentTextField: string;
  /** Field carrying a comment's time. */
  commentTimeField: string;
  /** Extra params for a standalone comments page. Empty unless the edge documents them. */
  drainParams: Readonly<Record<string, string>>;
  /** FR-027 to FR-029. Returns exactly the fields §2 confirms, and `null` for every other. */
  mapAuthor(comment: Record<string, unknown>): InboundItemDraft["author"];
  /** FR-016. True when the brand itself wrote this comment. */
  isSelf(comment: Record<string, unknown>, identity: MetaSelfIdentity): boolean;
  /**
   * One-off account-identity prefetch, or `null` when the surface needs none. Runs before the
   * first comment is read for an account and its result is cached in provider state.
   */
  prefetchSelf:
    | null
    | ((input: {
        accountExternalId: string;
        token: string;
        signal: AbortSignal;
      }) => Promise<{ kind: "ok"; selfUsername: string } | Exclude<GraphOutcome, { kind: "ok" }>>);
}

/** What the sweep knows about who the brand is, assembled from the account and provider state. */
export interface MetaSelfIdentity {
  /** The account's `externalId`: a Page id, or an IG user id. */
  externalId: string;
  /** Instagram only; `null` until `prefetchSelf` has run. */
  selfUsername: string | null;
}

const MAX_TEXT_LENGTH = 10_000;

/** Trims and returns `null` if the result is empty. */
function trimmedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** `null` when the comment's own time field is missing or unparseable — never defaulted to `now`. */
export function metaCommentTimeMs(surface: MetaCommentSurface, comment: Record<string, unknown>): number | null {
  const raw = comment[surface.commentTimeField];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The shared emit step (contracts/meta-engagement-sweep.md §4.3, §5): one `comment` object plus
 * its post id becomes one `InboundItemDraft`, or `null` when the comment is the brand's own
 * (FR-016), has no usable id, or carries an unparseable time. Never throws; never defaults a
 * missing time to `now`.
 */
export function mapMetaComment(surface: MetaCommentSurface, comment: Record<string, unknown>, postId: string, identity: MetaSelfIdentity): InboundItemDraft | null {
  if (surface.isSelf(comment, identity)) return null;

  const externalId = trimmedId(comment.id);
  if (!externalId) return null;

  const rawTime = comment[surface.commentTimeField];
  const saidAt = typeof rawTime === "string" || typeof rawTime === "number" ? new Date(rawTime) : null;
  if (!saidAt || Number.isNaN(saidAt.getTime())) return null;

  const rawText = comment[surface.commentTextField];
  const fullText = typeof rawText === "string" ? rawText : "";
  const textTruncated = fullText.length > MAX_TEXT_LENGTH;
  const text = textTruncated ? fullText.slice(0, MAX_TEXT_LENGTH) : fullText;

  return {
    kind: "comment",
    externalId,
    text,
    ...(textTruncated ? { textTruncated: true } : {}),
    author: surface.mapAuthor(comment),
    saidAt,
    parentExternalId: postId,
    data: {},
  };
}
