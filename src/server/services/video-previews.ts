import { z } from "zod";
import { postInputSchema } from "@/lib/validation/scheduling";
import { resolvePostType } from "../../providers/post-type";
import type { PostType } from "../../providers/types";
import { findProvider } from "../../providers/registry";
import { previewRecipe, type VideoPlan } from "../../providers/video-plan";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import type { VersionRequest, VideoVersionRow } from "../dal/video-versions";
import { videoRecipeKey } from "../media/hash";
import { checkVideoEdits } from "./posts/content";
import { itemOf, planVideoFor } from "./media-variants";

type Scope = Pick<ProjectScope, "posts" | "targets" | "accounts" | "media" | "videoVersions" | "can">;

export interface PreviewView {
  key: string;
  state: "queued" | "building" | "ready" | "failed";
  url: string | null;
  error: string | null;
}

/** At most this many keys per status request (contracts/video-composer.md). */
export const PREVIEW_STATUS_LIMIT = 50;

const requestSchema = postInputSchema.extend({ postId: z.uuid().optional(), retry: z.boolean().optional() });
const statusSchema = z.object({ keys: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(PREVIEW_STATUS_LIMIT).default([]) });

/** The preview the composer shows for an encoding plan: a ≤ 640 px look-alike of the full recipe (P16). Null when nothing is built. */
export function previewRequestFor(
  assetId: string,
  plan: VideoPlan,
  sourceFrameRate: number | null,
): (VersionRequest & { kind: "preview" }) | null {
  if (plan.kind !== "derive" || plan.mode !== "encode") return null;
  const recipe = previewRecipe(plan.recipe, sourceFrameRate);
  return { assetId, kind: "preview", key: videoRecipeKey("preview", recipe), recipe, steps: plan.steps, dueAt: new Date() };
}

export const viewOf = (row: VideoVersionRow): PreviewView => ({
  key: row.key,
  state: row.state as PreviewView["state"],
  url: row.state === "ready" ? row.publicUrl : null,
  error: row.state === "failed" ? row.error : null,
});

/**
 * Queues the preview of every video the composer state would adapt, one row per distinct recipe (shared like versions, US4 #4).
 * An unsaved edit plans like a saved one; a changed edit gives a new key, so the old preview is simply no longer asked for (US4 #2).
 * Never waited on by scheduling or publishing (US4 #3).
 */
export async function requestVideoPreviews(scope: Scope, input: unknown): Promise<{ previews: PreviewView[] }> {
  const parsed = requestSchema.parse(input);
  if (!scope.can({ post: ["edit"] })) throw new ForbiddenError();

  const ids = [...new Set(parsed.mediaIds)];
  const rows = new Map((await scope.media.getMany(ids)).map((r) => [r.id, r]));
  if (rows.size !== ids.length) throw new NotFoundError();
  const assets = parsed.mediaIds.map((id) => rows.get(id)!);
  if (!assets.some((a) => a.kind === "video")) return { previews: [] };
  const videoEdits = checkVideoEdits(assets, parsed.videoEdits);

  const stored = new Map<string, PostType | null>();
  if (parsed.postId) {
    if (!(await scope.posts.get(parsed.postId))) throw new NotFoundError();
    for (const t of await scope.targets.listForPost(parsed.postId)) stored.set(t.socialAccountId, t.chosenPostType);
  }

  const requests = new Map<string, VersionRequest>();
  for (const target of parsed.targets) {
    const account = await scope.accounts.get(target.accountId);
    if (!account) throw new NotFoundError();
    const provider = findProvider(account.providerKey);
    if (!provider) continue;
    const chosen = (target.postType !== undefined ? target.postType : stored.get(account.id)) ?? null;
    const postType = resolvePostType(provider.capabilities, assets.map((a) => itemOf(a)), chosen);
    for (const [index, asset] of assets.entries()) {
      if (asset.kind !== "video") continue;
      const plan = planVideoFor(asset, provider.capabilities, postType, index, provider.displayName, videoEdits.get(asset.id));
      const request = plan && previewRequestFor(asset.id, plan, itemOf(asset).video?.frameRate ?? null);
      if (request) requests.set(`${request.assetId}:${request.key}`, request);
    }
  }
  const queued = await scope.videoVersions.ensureQueued([...requests.values()], { ...(parsed.retry ? { requeueFailed: true } : {}) });
  return { previews: queued.map(viewOf) };
}

/** The state of previews by key, for polling. Keys that match nothing are left out. */
export async function videoPreviewStatus(scope: Scope, input: unknown): Promise<{ previews: PreviewView[] }> {
  const { keys } = statusSchema.parse(input);
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
  return { previews: (await scope.videoVersions.getPreviewsByKeys(keys)).map(viewOf) };
}
