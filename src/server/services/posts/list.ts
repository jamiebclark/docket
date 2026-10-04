import { z } from "zod";
import { ForbiddenError } from "../../dal/errors";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";

export const POSTS_PAGE_SIZE = 25;
const EXCERPT_GRAPHEMES = 140;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const listSchema = z.object({
  status: z.enum(["draft", "needs_review", "approved", "scheduled", "publishing", "published", "partially_failed", "failed", "rejected", "needs_decision"] satisfies (PostRecord["status"] | "needs_decision")[]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

export interface PostListItem {
  id: string;
  excerpt: string;
  status: PostRecord["status"];
  needsDecision: boolean;
  /** Next scheduled time for live posts, else the latest published time. */
  relevantAt: Date | null;
  targets: { id: string; accountId: string; accountName: string; status: TargetRecord["status"] }[];
}

export interface PostList {
  items: PostListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<PostRecord["status"] | "needs_decision", number>;
}

/** The first 140 graphemes, with an ellipsis when cut. */
export function excerptOf(text: string): string {
  const parts = [...segmenter.segment(text)];
  return parts.length > EXCERPT_GRAPHEMES
    ? `${parts.slice(0, EXCERPT_GRAPHEMES).map((p) => p.segment).join("")}…`
    : text;
}

export async function listPosts(scope: ProjectScope, input: unknown = {}): Promise<PostList> {
  const q = listSchema.parse(input);
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
  const { rows, total } = await scope.posts.list({
    ...(q.status === "needs_decision" ? { needsDecision: true } : q.status ? { status: q.status } : {}),
    limit: POSTS_PAGE_SIZE,
    offset: (q.page - 1) * POSTS_PAGE_SIZE,
  });
  const names = new Map((await scope.accounts.list()).map((a) => [a.id, a.displayName]));
  return {
    items: rows.map((r) => ({
      id: r.post.id,
      excerpt: excerptOf(r.post.baseText),
      status: r.post.status,
      needsDecision: r.needsDecision,
      relevantAt: r.relevantAt,
      targets: r.targets.map((t) => ({
        id: t.id,
        accountId: t.socialAccountId,
        accountName: names.get(t.socialAccountId) ?? "Removed account",
        status: t.status,
      })),
    })),
    total,
    page: q.page,
    pageSize: POSTS_PAGE_SIZE,
    counts: await scope.posts.counts(),
  };
}
