"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import * as media from "@/server/services/media";
import { runAction } from "../run-action";

export async function updateMediaAction(
  slug: string,
  input: { id: string; altText?: string; tags?: string[] },
): Promise<ActionResult<media.MediaView>> {
  const result = await runAction(slug, (scope) => {
    const { id, ...patch } = input ?? ({} as typeof input);
    return media.updateMedia(scope, id, patch);
  });
  if (result.ok) refresh();
  return result;
}

export async function deleteMediaImpactAction(
  slug: string,
  input: { id: string },
): Promise<ActionResult<Awaited<ReturnType<typeof media.deleteMediaImpact>>>> {
  return runAction(slug, (scope) => media.deleteMediaImpact(scope, input?.id));
}

export async function deleteMediaAction(slug: string, input: { id: string }): Promise<ActionResult<{ affected: media.PostRef[] }>> {
  const result = await runAction(slug, (scope) => media.deleteMedia(scope, input?.id));
  if (result.ok) refresh();
  return result;
}

/** The picker's library query (client-side filters over a page of 24). */
export async function listMediaAction(
  slug: string,
  input: { tag?: string; unused?: boolean; q?: string; states?: ("processing" | "ready" | "failed")[]; page?: number; fit?: { accountIds: string[] } },
): Promise<ActionResult<Awaited<ReturnType<typeof media.listMedia>>>> {
  return runAction(slug, (scope) => media.listMedia(scope, input ?? {}));
}
