import type { VideoEdit } from "../../../lib/video/edit";
import { findProvider } from "../../../providers/registry";
import { resolvePostType } from "../../../providers/post-type";
import type { PostContent, PostType, SocialProvider, ValidationIssue } from "../../../providers/types";
import type { AccountRecord } from "../../dal/accounts";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import { adaptedMediaFor, itemOf } from "../media-variants";

export interface TargetContent {
  text: string;
  /** Live assets in post order. */
  assets: readonly MediaRow[];
  /** How many images the post references; more than `assets` means some were deleted. */
  referenced: number;
  /** The target's stored post type choice; absent or null = the provider's default. */
  chosenPostType?: PostType | null;
  /** The post's video edits by media id; a video without one uses the default edit. */
  videoEdits?: ReadonlyMap<string, VideoEdit>;
}

type Tx = Pick<ProjectScope, "targets" | "posts" | "media">;

/** Effective text of the target plus the live assets of its post. `null` when the target's post is gone. */
export async function loadTargetContent(tx: Tx, target: TargetRecord): Promise<TargetContent | null> {
  const content = await tx.targets.effectiveContent(target.id);
  if (!content) return null;
  const ids = await tx.posts.listMediaIds(target.postId);
  const rows = new Map((await tx.media.getMany(ids)).map((r) => [r.id, r]));
  const assets = ids.map((id) => rows.get(id)).filter((r): r is MediaRow => !!r);
  return {
    text: content.text,
    assets,
    referenced: ids.length,
    chosenPostType: target.chosenPostType,
    videoEdits: await tx.posts.listVideoEdits(target.postId),
  };
}

const FIELD_RANK = (field: string): number =>
  field === "text" ? 0 : field === "postType" ? 1 : field === "media" ? 2 : 3 + Number(field.split(".")[1] ?? 0);

/**
 * Provider validation of already-resolved content. The single core of every content check
 * (constitution IV): the scheduling gate and the publish engine both call it, so they word a refusal identically.
 */
export function validateResolvedContent(provider: SocialProvider, content: PostContent): ValidationIssue[] {
  return provider.validate(content, provider.capabilities);
}

/**
 * The one validation path (FR-006–FR-017): adapted media → provider validation → the planner's notes and
 * refusals, merged in a stable order (text, postType, media, media.0, media.1 …). `null` when the provider
 * is not registered.
 */
export async function validateTargetContent(
  tx: Pick<ProjectScope, "media">,
  account: Pick<AccountRecord, "providerKey">,
  content: TargetContent,
  opts: { preview?: boolean } = {},
): Promise<ValidationIssue[] | null> {
  const provider = findProvider(account.providerKey);
  if (!provider) return null;
  const draftType = resolvePostType(provider.capabilities, content.assets.map((a) => itemOf(a)), content.chosenPostType ?? null);
  const { media, issues: planIssues } = await adaptedMediaFor(tx, provider.capabilities, provider.displayName, content.assets, {
    ...opts,
    postType: draftType,
    ...(content.videoEdits ? { videoEdits: content.videoEdits } : {}),
  });
  // An image the planner already refused (or could not adapt) would only repeat itself as a provider error.
  const planned = new Set(planIssues.filter((i) => i.severity === "error").map((i) => i.field));
  const postType = resolvePostType(provider.capabilities, media, content.chosenPostType ?? null);
  const providerIssues = validateResolvedContent(provider, { text: content.text, media, postType }).filter((i) => !planned.has(i.field));
  const unavailable: ValidationIssue[] =
    content.referenced > content.assets.length
      ? [{ severity: "error", code: "media_unavailable", message: "An image on this post has been deleted.", field: "media" }]
      : [];
  const merged = [...providerIssues, ...unavailable, ...planIssues];
  return merged
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => FIELD_RANK(a.issue.field) - FIELD_RANK(b.issue.field) || a.i - b.i)
    .map((x) => x.issue);
}
