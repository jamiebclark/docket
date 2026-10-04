// generation/save: the one place a generated post is written (single, series and job items share it).
import type { GenerationRecord } from "@/lib/validation/generation";
import type { AccountRecord } from "../../dal/accounts";
import * as clock from "../../dal/clock";
import { NotFoundError } from "../../dal/errors";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope, SchedulingPolicy } from "../../dal/scope";
import { applyDerivedStatus } from "../posts";

/** Fills a media asset's alt text only where it is empty (research D9). */
export async function fillEmptyAltTexts(
  tx: ProjectScope,
  assets: readonly MediaRow[],
  alts: readonly string[] | null,
): Promise<void> {
  if (!alts) return;
  for (const [i, asset] of assets.entries()) {
    const alt = alts[i]?.trim();
    if (alt && asset.altText.trim() === "") await tx.media.updateAlt(asset.id, alt);
  }
}

export type GeneratedPostLink =
  | { generationRequestId: string }
  | { seriesId: string; seriesPosition: number }
  | { generationJobItemId: string };

/** Writes the post, its media and its targets in the caller's transaction and returns the post id. */
export async function saveGeneratedPost(
  tx: ProjectScope,
  args: {
    /** The first account decides `base_text` (007 D10). */
    accounts: AccountRecord[];
    variants: Record<string, string>;
    assets: MediaRow[];
    imageAltTexts: string[] | null;
    record: GenerationRecord;
    schedulingPolicy: SchedulingPolicy;
    createdByUserId: string | null;
    link: GeneratedPostLink;
  },
): Promise<string> {
  const now = await clock.now();
  const mediaIds = args.assets.map((a) => a.id);
  if ((await tx.media.lockShared(mediaIds)).length !== new Set(mediaIds).size) throw new NotFoundError();
  const variantOf = (a: AccountRecord) => args.variants[a.providerKey] ?? "";
  const post = await tx.posts.insert({
    baseText: variantOf(args.accounts[0]!),
    createdByUserId: args.createdByUserId,
    origin: "generated",
    reviewState: "needs_review",
    schedulingPolicy: args.schedulingPolicy,
    ...args.link,
    generationMetadata: { v: 1, records: [args.record] },
  });
  await tx.posts.setMedia(post.id, mediaIds);
  await tx.media.markUsed(mediaIds, now);
  await tx.targets.insertMany(
    args.accounts.map((a) => ({ postId: post.id, socialAccountId: a.id, overrideText: variantOf(a) })),
  );
  await fillEmptyAltTexts(tx, args.assets, args.imageAltTexts);
  await applyDerivedStatus(tx, post.id);
  return post.id;
}
