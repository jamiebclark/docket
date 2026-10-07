import { mediaConstraintsOf, planImage, type ImagePlan, type MediaConstraints } from "../../providers/media";
import { findProvider } from "../../providers/registry";
import type { MediaItem, ProviderCapabilities, SocialProvider, ValidationIssue } from "../../providers/types";
import type { MediaRow, VariantRow } from "../dal/media";
import type { createSchedulingRepos } from "../dal/scope";
import { constraintsHash } from "../media/hash";
import { videoFieldsOf } from "../media/item";
import { generateVariant } from "../media/variants";
import { getStorage, mediaKeys } from "../storage";
import type { Storage } from "../storage";

type Repos = ReturnType<typeof createSchedulingRepos>;
type PrepareRepos = Pick<Repos, "posts" | "targets" | "accounts" | "media">;
type Derive = Extract<ImagePlan, { kind: "derive" }>;

const MAX_CONCURRENT_PAIRS = 4;
const NOT_SET_UP = "Media storage is not set up.";

export interface VariantFailure {
  assetId: string;
  providerKey: string;
  message: string;
}

/**
 * An asset registered without dimensions cannot be planned: it goes as is and the provider's own checks apply.
 * `label` replaces "Image N" in the planner's sentences (the library names no position).
 */
export const planFor = (asset: MediaRow, c: MediaConstraints, index: number, platform: string, label?: string): ImagePlan =>
  asset.kind !== "video" && asset.width && asset.height
    ? planImage({ mimeType: asset.mimeType, width: asset.width, height: asset.height, bytes: asset.byteSize }, c, {
        index,
        platform,
        ...(label ? { label } : {}),
      })
    : { kind: "original" };

/** The item the provider's checks see for a plan: the planned output for `derive`, the stored row otherwise. */
export function plannedItem(asset: MediaRow, plan: Exclude<ImagePlan, { kind: "refuse" }>): MediaItem {
  if (plan.kind === "original") return itemOf(asset);
  const { mimeType, width, height, maxBytes } = plan.output;
  return { ...itemOf(asset), mimeType, width, height, bytes: Math.min(asset.byteSize, maxBytes) };
}

const itemOf = (asset: MediaRow, v?: VariantRow): MediaItem => ({
  url: v?.publicUrl ?? asset.publicUrl,
  mimeType: v?.mimeType ?? asset.mimeType,
  width: v?.width ?? asset.width,
  height: v?.height ?? asset.height,
  bytes: v?.byteSize ?? asset.byteSize,
  altText: asset.altText,
  ...videoFieldsOf(asset),
});

/** Live assets of a post, in post order. */
async function orderedAssets(repos: Pick<Repos, "posts" | "media">, postId: string, mediaIds?: readonly string[]) {
  const ids = mediaIds ?? (await repos.posts.listMediaIds(postId));
  const rows = new Map((await repos.media.getMany(ids)).map((r) => [r.id, r]));
  return { ids, rows, assets: ids.map((id) => rows.get(id)).filter((r): r is MediaRow => !!r) };
}

/**
 * Builds one variant: original from storage → generate → put → insert row. Returns the row, or a message
 * with no keys or URLs in it. When a row already exists but its object vanished, the object is rewritten
 * at the same key.
 */
async function buildVariant(
  repos: Pick<Repos, "media">,
  projectId: string,
  storage: Storage,
  asset: MediaRow,
  c: MediaConstraints,
  hash: string,
  plan: Derive,
  existing?: VariantRow | null,
): Promise<{ ok: true; row: VariantRow } | { ok: false; message: string }> {
  const original = await storage.get(asset.storageKey).catch(() => null);
  if (!original) return { ok: false, message: "The original image is no longer available." };
  const out = await generateVariant(original, plan, c);
  if (!out.ok) return out;
  const key = existing?.storageKey ?? mediaKeys(projectId, asset.id).variant(hash, out.ext);
  try {
    await storage.put(key, out.body, out.mimeType);
  } catch {
    return { ok: false, message: "The adapted image could not be stored." };
  }
  if (existing) return { ok: true, row: existing };
  const row = await repos.media.insertVariant({
    mediaAssetId: asset.id,
    constraintsHash: hash,
    storageKey: key,
    publicUrl: storage.publicUrl(key),
    mimeType: out.mimeType,
    width: out.width,
    height: out.height,
    byteSize: out.bytes,
    steps: plan.steps,
  });
  return { ok: true, row };
}

async function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Outside any transaction. Ensures a variant for every (image, provider) pair whose plan is `derive`.
 * `mediaIds` plans for images about to be attached (an edit that has not been saved yet).
 * Pairs are grouped by `(asset, constraints hash)`; one pair failing never stops the others.
 */
export async function prepareVariants(
  scope: PrepareRepos & { project: { id: string } },
  postId: string,
  opts: { targetIds?: string[]; mediaIds?: readonly string[] } = {},
): Promise<{ failures: VariantFailure[] }> {
  const { assets } = await orderedAssets(scope, postId, opts.mediaIds);
  const failures: VariantFailure[] = [];
  if (assets.length === 0) return { failures };

  const wanted = opts.targetIds ? new Set(opts.targetIds) : null;
  const targets = (await scope.targets.listForPost(postId)).filter(
    (t) => t.status !== "cancelled" && (!wanted || wanted.has(t.id)),
  );
  const providers = new Map<string, SocialProvider>();
  for (const t of targets) {
    const account = await scope.accounts.get(t.socialAccountId);
    const provider = account && findProvider(account.providerKey);
    if (provider) providers.set(provider.key, provider);
  }

  interface Pair {
    asset: MediaRow;
    providerKey: string;
    c: MediaConstraints;
    hash: string;
    plan: Derive;
  }
  const pairs = new Map<string, Pair>();
  for (const provider of providers.values()) {
    const c = mediaConstraintsOf(provider.capabilities);
    const hash = constraintsHash(c);
    for (const [i, asset] of assets.entries()) {
      const plan = planFor(asset, c, i, provider.displayName);
      if (plan.kind !== "derive") continue;
      const key = `${asset.id}:${hash}`;
      if (!pairs.has(key)) pairs.set(key, { asset, providerKey: provider.key, c, hash, plan });
    }
  }

  const todo: Pair[] = [];
  for (const p of pairs.values()) if (!(await scope.media.getVariant(p.asset.id, p.hash))) todo.push(p);
  if (todo.length === 0) return { failures };

  const storage = getStorage();
  if (!storage) {
    return { failures: todo.map((p) => ({ assetId: p.asset.id, providerKey: p.providerKey, message: NOT_SET_UP })) };
  }
  await pool(todo, MAX_CONCURRENT_PAIRS, async (p) => {
    try {
      const r = await buildVariant(scope, scope.project.id, storage, p.asset, p.c, p.hash, p.plan);
      if (!r.ok) failures.push({ assetId: p.asset.id, providerKey: p.providerKey, message: r.message });
    } catch {
      failures.push({ assetId: p.asset.id, providerKey: p.providerKey, message: "The image could not be adapted." });
    }
  });
  return { failures };
}

/**
 * Outside any transaction. The cached variant of `asset` for arbitrary `constraints` (used for model input),
 * building it when missing. `variant: null` means the original already fits.
 */
export async function ensureVariant(
  scope: Pick<Repos, "media"> & { project: { id: string } },
  asset: MediaRow,
  c: MediaConstraints,
  index = 0,
): Promise<{ ok: true; variant: VariantRow | null } | { ok: false; message: string }> {
  if (asset.kind === "video") return { ok: false, message: "Videos are not sent to the model." };
  const plan = planFor(asset, c, index, "the model");
  if (plan.kind === "original") return { ok: true, variant: null };
  if (plan.kind === "refuse") return { ok: false, message: plan.issues[0]?.message ?? "The image cannot be used." };
  const hash = constraintsHash(c);
  const existing = await scope.media.getVariant(asset.id, hash);
  const storage = getStorage();
  if (existing && (!storage || (await storage.exists(existing.storageKey).catch(() => true)))) {
    return { ok: true, variant: existing };
  }
  if (!storage) return { ok: false, message: NOT_SET_UP };
  const r = await buildVariant(scope, scope.project.id, storage, asset, c, hash, plan, existing);
  return r.ok ? { ok: true, variant: r.row } : { ok: false, message: r.message };
}

/** Inside the gate: adapted media for one target, or issues (a missing variant row → `variant_failed`). */
export async function adaptedMediaFor(
  tx: Pick<Repos, "media">,
  caps: ProviderCapabilities,
  platform: string,
  assets: readonly MediaRow[],
  /** `preview`: no variant exists yet (an unsaved composition), so the planned output stands in for it. */
  opts: { preview?: boolean } = {},
): Promise<{ media: MediaItem[]; issues: ValidationIssue[] }> {
  const c = mediaConstraintsOf(caps);
  const hash = constraintsHash(c);
  const media: MediaItem[] = [];
  const issues: ValidationIssue[] = [];
  for (const [i, asset] of assets.entries()) {
    const plan = planFor(asset, c, i, platform);
    if (plan.kind === "original") media.push(itemOf(asset));
    else if (plan.kind === "refuse") {
      issues.push(...plan.issues);
      media.push(itemOf(asset));
    } else {
      const variant = await tx.media.getVariant(asset.id, hash);
      if (variant) {
        media.push(itemOf(asset, variant));
        issues.push(...plan.notes);
      } else if (opts.preview) {
        media.push(plannedItem(asset, plan));
        issues.push(...plan.notes);
      } else {
        issues.push({
          severity: "error",
          code: "variant_failed",
          message: `Image ${i + 1} could not be adapted for ${platform}.`,
          field: `media.${i}`,
        });
        media.push(itemOf(asset));
      }
    }
  }
  return { media, issues };
}

/** Scheduler, outside any transaction: resolve media, check the objects exist, regenerate what vanished. */
export async function resolvePublishMedia(
  repos: PrepareRepos & { projectId: string },
  targetId: string,
  provider: SocialProvider,
): Promise<{ ok: true; media: MediaItem[] } | { ok: false; error: string }> {
  const target = await repos.targets.get(targetId);
  if (!target) return { ok: false, error: "The post is no longer available." };
  const { ids, rows } = await orderedAssets(repos, target.postId);
  if (ids.length === 0) return { ok: true, media: [] };
  const gone = ids.findIndex((id) => !rows.has(id));
  if (gone >= 0) return { ok: false, error: `Image ${gone + 1} is no longer available.` };

  const storage = getStorage();
  const c = mediaConstraintsOf(provider.capabilities);
  const hash = constraintsHash(c);
  const media: MediaItem[] = [];
  for (const [i, id] of ids.entries()) {
    const asset = rows.get(id)!;
    const noun = asset.kind === "video" ? "Video" : "Image";
    const unavailable = { ok: false as const, error: `${noun} ${i + 1} is no longer available.` };
    if (storage && !(await storage.exists(asset.storageKey).catch(() => true))) return unavailable;
    const plan = planFor(asset, c, i, provider.displayName);
    if (plan.kind === "original") {
      media.push(itemOf(asset));
      continue;
    }
    if (plan.kind === "refuse") return { ok: false, error: plan.issues[0]?.message ?? `Image ${i + 1} cannot be used.` };
    let variant = await repos.media.getVariant(asset.id, hash);
    if (!storage) {
      if (!variant) return { ok: false, error: NOT_SET_UP };
    } else if (!variant || !(await storage.exists(variant.storageKey).catch(() => true))) {
      const r = await buildVariant(repos, repos.projectId, storage, asset, c, hash, plan, variant);
      if (!r.ok) return { ok: false, error: `Image ${i + 1}: ${r.message}` };
      variant = r.row;
    }
    media.push(itemOf(asset, variant ?? undefined));
  }
  return { ok: true, media };
}
