// standing-series/media: resolve one position's media (contracts/services.md §7.3 step 4).
import { findProvider } from "@/providers/registry";
import type { StandingSeriesRunConfig } from "@/lib/validation/standing-series";
import type { AccountRecord } from "../../dal/accounts";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope } from "../../dal/scope";
import type { StandingSeriesPositionRecord } from "../../dal/standing-series";
import { imagesForModel } from "../../llm/images";
import { getImageStatus } from "../../llm/image-provider";
import { MEDIA_STORAGE_NOT_SET_UP } from "../../storage";
import { generateImageWithKind } from "../media-generate";

export type StandingSeriesSkipReason =
  | "pool_exhausted"
  | "image_generation_not_configured"
  | "image_generation_failed"
  | "media_unusable"
  | "media_storage_not_configured";

export type MediaOutcome =
  | { ok: true; assets: MediaRow[] }
  | { ok: false; skip: { reason: StandingSeriesSkipReason; accountId: string | null }; requeue?: false }
  | { ok: false; requeue: true };

/** The one target that actually needs an image, if any; a missing image only matters for this account (FR-038). */
function accountNeedingMedia(accounts: readonly AccountRecord[]): AccountRecord | null {
  return accounts.find((a) => findProvider(a.providerKey)?.capabilities.media.required) ?? null;
}

export async function resolvePositionMedia(
  scope: ProjectScope,
  position: StandingSeriesPositionRecord,
  media: StandingSeriesRunConfig["media"],
  accounts: readonly AccountRecord[],
): Promise<MediaOutcome> {
  const required = accountNeedingMedia(accounts);
  const fail = (reason: StandingSeriesSkipReason): MediaOutcome =>
    required ? { ok: false, skip: { reason, accountId: required.id } } : { ok: true, assets: [] };

  if (media.source === "none") return { ok: true, assets: [] };

  let asset: MediaRow | null = null;
  if (position.mediaAssetId) {
    const existing = await scope.media.getMany([position.mediaAssetId]);
    asset = existing[0] ?? null;
  }

  if (!asset) {
    if (media.source === "pool") {
      asset = await scope.transaction(async (tx) => {
        const claimed = await tx.media.claimPoolImage({ tag: media.tag ?? null });
        if (!claimed) return null;
        await tx.standingSeriesPositions.claimMedia(position.id, claimed.id);
        return claimed;
      });
      if (!asset) return fail("pool_exhausted");
    } else {
      // "generate" — outside every transaction, the same shared contract every image generation uses.
      const result = await generateImageWithKind(scope, { projectId: scope.project.id, prompt: media.prompt });
      if (!result.ok) {
        // A billing refusal isn't a terminal media failure: the caller requeues it with no attempt
        // counted, exactly like the text model call's own `credit_exhausted` path (review F5).
        if (result.kind === "credit_exhausted") return { ok: false, requeue: true };
        if (!getImageStatus().configured) return fail("image_generation_not_configured");
        if (result.message === MEDIA_STORAGE_NOT_SET_UP) return fail("media_storage_not_configured");
        return fail("image_generation_failed");
      }
      await scope.standingSeriesPositions.claimMedia(position.id, result.mediaAssetId);
      const rows = await scope.media.getMany([result.mediaAssetId]);
      asset = rows[0] ?? null;
    }
  }
  if (!asset) return fail("image_generation_failed");

  const prepared = await imagesForModel(scope, [asset]);
  if (!prepared.ok) return fail("media_unusable");

  return { ok: true, assets: [asset] };
}
