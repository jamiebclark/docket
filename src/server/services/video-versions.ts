import { findProvider } from "../../providers/registry";
import { resolvePostType } from "../../providers/post-type";
import type { ProjectScope } from "../dal/scope";
import type { VersionRequest } from "../dal/video-versions";
import { videoRecipeKey } from "../media/hash";
import { itemOf, planVideoFor } from "./media-variants";
import { previewRequestFor } from "./video-previews";

type Scope = Pick<ProjectScope, "posts" | "targets" | "accounts" | "media" | "videoVersions"> & { project: { id: string } };

/**
 * Queues the adapted file every `scheduled` or `publishing` target of the post needs, one row per distinct recipe: targets with
 * identical limits and edits share a version (P2). Drafts get none (D10). Outside any transaction, after the caller's commit.
 * It never throws: a failure is logged and the claim-time gate heals it (contracts/video-publishing.md).
 */
export async function syncVideoVersions(
  scope: Scope,
  postId: string,
  opts: { requeueFailed?: boolean; targetIds?: readonly string[] } = {},
): Promise<void> {
  try {
    const ids = await scope.posts.listMediaIds(postId);
    if (ids.length === 0) return;
    const rows = new Map((await scope.media.getMany(ids)).map((r) => [r.id, r]));
    const assets = ids.map((id) => rows.get(id)).filter((r) => r !== undefined);
    if (!assets.some((a) => a.kind === "video")) return;

    const videoEdits = await scope.posts.listVideoEdits(postId);
    const wanted = opts.targetIds ? new Set(opts.targetIds) : null;
    const targets = (await scope.targets.listForPost(postId)).filter(
      (t) => (t.status === "scheduled" || t.status === "publishing") && (!wanted || wanted.has(t.id)),
    );
    const requests = new Map<string, VersionRequest>();
    for (const target of targets) {
      const account = await scope.accounts.get(target.socialAccountId);
      const provider = account && findProvider(account.providerKey);
      if (!provider) continue;
      const postType = resolvePostType(provider.capabilities, assets.map((a) => itemOf(a)), target.chosenPostType ?? null);
      for (const [i, asset] of assets.entries()) {
        const plan = planVideoFor(asset, provider.capabilities, postType, i, provider.displayName, videoEdits.get(asset.id));
        if (plan?.kind !== "derive") continue;
        const key = videoRecipeKey("full", plan.recipe);
        const id = `${asset.id}:${key}`;
        const due = target.scheduledAt;
        const have = requests.get(id);
        if (have) {
          if (due && (!have.dueAt || due < have.dueAt)) have.dueAt = due;
        } else {
          requests.set(id, { assetId: asset.id, kind: "full", key, recipe: plan.recipe, steps: plan.steps, dueAt: due });
        }
      }
    }
    await scope.videoVersions.ensureQueued([...requests.values()], { ...(opts.requeueFailed ? { requeueFailed: true } : {}) });
  } catch (err) {
    console.error(`Docket video: could not queue versions: ${err instanceof Error ? err.message : "unknown error"}`.slice(0, 500));
  }
}

/**
 * The `kind:key` of every full version and preview that a post using the asset still plans today, from the posts' saved
 * edits and targets (pure planner, no tool). Housekeeping keeps exactly these (P17, FR-033).
 */
export async function wantedVideoKeys(scope: Scope, assetId: string): Promise<Set<string>> {
  const wanted = new Set<string>();
  const asset = (await scope.media.getMany([assetId]))[0];
  if (!asset || asset.kind !== "video") return wanted;
  for (const { postId } of await scope.media.postsUsing(assetId)) {
    if (!(await scope.posts.get(postId))) continue;
    const ids = await scope.posts.listMediaIds(postId);
    const rows = new Map((await scope.media.getMany(ids)).map((r) => [r.id, r]));
    const assets = ids.map((id) => rows.get(id)).filter((r) => r !== undefined);
    const index = assets.findIndex((a) => a.id === assetId);
    if (index < 0) continue;
    const edit = (await scope.posts.listVideoEdits(postId)).get(assetId);
    for (const target of await scope.targets.listForPost(postId)) {
      const account = await scope.accounts.get(target.socialAccountId);
      const provider = account && findProvider(account.providerKey);
      if (!provider) continue;
      const postType = resolvePostType(provider.capabilities, assets.map((a) => itemOf(a)), target.chosenPostType ?? null);
      const plan = planVideoFor(asset, provider.capabilities, postType, index, provider.displayName, edit);
      if (plan?.kind !== "derive") continue;
      wanted.add(`full:${videoRecipeKey("full", plan.recipe)}`);
      const preview = previewRequestFor(assetId, plan, itemOf(asset).video?.frameRate ?? null);
      if (preview) wanted.add(`preview:${preview.key}`);
    }
  }
  return wanted;
}
