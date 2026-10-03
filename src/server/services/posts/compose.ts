import { z } from "zod";
import { findProvider } from "@/providers/registry";
import { countText } from "@/providers/text";
import type { PostType, TextCountingRule, ValidationIssue } from "@/providers/types";
import { inferPostType } from "@/providers/validation";
import { postInputSchema } from "@/lib/validation/scheduling";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { validateTargetContent } from "./validate";

const STARTED = ["publishing", "published", "ambiguous"] as const;

const checkSchema = postInputSchema.extend({ postId: z.uuid().optional() });

export interface TargetCheck {
  accountId: string;
  displayName: string;
  providerName: string;
  effectiveText: string;
  count: number;
  limit: number | null;
  countingRule: TextCountingRule | null;
  postType: PostType | null;
  issues: ValidationIssue[];
  canSchedule: boolean;
}

export interface CompositionCheck {
  targets: TargetCheck[];
  /** No target of the saved post has started publishing. */
  editable: boolean;
  /** The saved post is waiting for review. */
  reviewBlocked: boolean;
}

/**
 * Per-target counts and issues for composer state that may not be saved (FR-002–FR-005). Same validation
 * path as scheduling, so the numbers here are the numbers `addToQueue` enforces. Writes nothing.
 */
export async function checkComposition(scope: ProjectScope, input: unknown): Promise<CompositionCheck> {
  const parsed = checkSchema.parse(input);
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();

  const ids = [...new Set(parsed.mediaIds)];
  const rows = new Map((await scope.media.getMany(ids)).map((r) => [r.id, r]));
  if (rows.size !== ids.length) throw new NotFoundError();
  const assets = parsed.mediaIds.map((id) => rows.get(id)!);

  let editable = true;
  let reviewBlocked = false;
  if (parsed.postId) {
    const post = await scope.posts.get(parsed.postId);
    if (!post) throw new NotFoundError();
    reviewBlocked = post.reviewState === "needs_review";
    editable = !(await scope.targets.listForPost(post.id)).some((t) => (STARTED as readonly string[]).includes(t.status));
  }

  const targets: TargetCheck[] = [];
  for (const target of parsed.targets) {
    const account = await scope.accounts.get(target.accountId);
    if (!account) throw new NotFoundError();
    const provider = findProvider(account.providerKey);
    const effectiveText = target.overrideText ? target.overrideText : parsed.baseText;
    const media = assets.map((a) => ({ url: a.publicUrl, mimeType: a.mimeType, width: a.width, height: a.height, bytes: a.byteSize, altText: a.altText }));
    const issues =
      (await validateTargetContent(scope, account, { text: effectiveText, assets, referenced: assets.length }, { preview: true })) ?? [];
    const rule = provider?.capabilities.text.countingRule ?? null;
    targets.push({
      accountId: account.id,
      displayName: account.displayName,
      providerName: provider?.displayName ?? account.providerKey,
      effectiveText,
      count: rule ? countText(effectiveText, rule) : 0,
      limit: provider?.capabilities.text.maxLength ?? null,
      countingRule: rule,
      postType: provider ? inferPostType({ text: effectiveText, media }) : null,
      issues,
      canSchedule: !!provider && account.status === "active" && !issues.some((i) => i.severity === "error"),
    });
  }
  return { targets, editable, reviewBlocked };
}
