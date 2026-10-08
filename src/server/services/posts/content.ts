import { z } from "zod";
import { assertEditFits, VideoEditError, type VideoEdit } from "../../../lib/video/edit";
import { offeredPostTypes } from "../../../providers/post-type";
import { findProvider } from "../../../providers/registry";
import type { MediaItem, PostContent, PostType } from "../../../providers/types";
import { inferPostType } from "../../../providers/validation";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";

export { inferPostType };

/** Effective content of a target: `override_text ?? base_text` plus the post's media in order. */
export async function effectiveContent(tx: Pick<ProjectScope, "targets">, target: TargetRecord): Promise<PostContent | null> {
  const content = await tx.targets.effectiveContent(target.id);
  if (!content) return null;
  const media: MediaItem[] = content.media.map((m) => ({ ...m }));
  return { text: content.text, media };
}

/** Why `value` cannot be chosen for an account of this provider, or `null` when it can. */
export function postTypeRefusal(providerKey: string, value: PostType): string | null {
  const provider = findProvider(providerKey);
  const name = provider?.displayName ?? providerKey;
  const offered = offeredPostTypes(provider?.capabilities ?? null);
  if (offered.length === 0) return `${name} offers no post type choice`;
  if (!offered.includes(value)) return `"${value}" is not offered for ${name}; allowed: ${offered.join(", ")}`;
  return null;
}

/** Throws a `ZodError` at `path` (400 with the message) when the provider does not offer `value`. */
export function assertPostTypeOffered(
  providerKey: string,
  value: PostType,
  path: readonly (string | number)[],
): void {
  const message = postTypeRefusal(providerKey, value);
  if (message) throw new z.ZodError([{ code: "custom", path: [...path], message }]);
}

/** Checks an API `postTypes` map (account id to type) against the request's accounts; throws a `ZodError` at `postTypes.<id>`. */
export async function assertPostTypesForAccounts(
  scope: ProjectScope,
  accountIds: readonly string[],
  postTypes: Readonly<Record<string, PostType>> | undefined,
): Promise<void> {
  for (const [accountId, value] of Object.entries(postTypes ?? {})) {
    const issue = (message: string) => new z.ZodError([{ code: "custom", path: ["postTypes", accountId], message }]);
    if (!accountIds.includes(accountId)) throw issue("This account is not in accountIds");
    const account = await scope.accounts.get(accountId);
    const message = account ? postTypeRefusal(account.providerKey, value) : null;
    if (message) throw issue(message);
  }
}

/**
 * Checks the submitted edits against the post's media: each key must be a video on the post and each trim must fit that video.
 * Throws a `ZodError` at `videoEdits.<id>` (or `videoEdits.<id>.<field>`); returns the edits with a full-length end normalised to null.
 * A video not yet probed has no length to check against, so only its shape is checked.
 */
export function checkVideoEdits(
  assets: readonly Pick<MediaRow, "id" | "kind" | "durationMs">[],
  edits: Readonly<Record<string, VideoEdit>>,
): Map<string, VideoEdit> {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = new Map<string, VideoEdit>();
  for (const [id, edit] of Object.entries(edits)) {
    const asset = byId.get(id);
    if (!asset || asset.kind !== "video") {
      throw new z.ZodError([{ code: "custom", path: ["videoEdits", id], message: "This video is not on the post." }]);
    }
    try {
      out.set(id, asset.durationMs === null ? edit : assertEditFits(edit, asset.durationMs));
    } catch (err) {
      if (err instanceof VideoEditError) {
        throw new z.ZodError([{ code: "custom", path: ["videoEdits", id, err.field], message: err.message }]);
      }
      throw err;
    }
  }
  return out;
}
