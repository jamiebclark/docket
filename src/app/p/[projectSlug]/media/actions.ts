"use server";

import { refresh } from "next/cache";
import { fail, type ActionResult } from "@/lib/action-result";
import * as media from "@/server/services/media";
import { runAction } from "../run-action";

type Uploaded = Awaited<ReturnType<typeof media.uploadMedia>>;

/** One file per call so a batch reports per file. Rejections come back as `{ ok: false }` data, not thrown. */
export async function uploadMediaAction(slug: string, formData: FormData): Promise<ActionResult<Uploaded>> {
  const file = formData.get("file");
  if (!(file instanceof File)) return fail("validation", "Choose an image to upload.");
  const result = await runAction(slug, async (scope) => {
    const status = await media.mediaStatus(scope);
    // Size is checked before the body is read into memory.
    if (file.size > status.maxUploadBytes) {
      return {
        ok: false as const,
        code: "too_large" as const,
        message: `That file is larger than ${Math.floor(status.maxUploadBytes / 1024 / 1024)} MB.`,
      };
    }
    return media.uploadMedia(scope, { file: { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) } });
  });
  if (result.ok && result.data.ok) refresh();
  return result;
}

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
  input: { tag?: string; unused?: boolean; q?: string; page?: number },
): Promise<ActionResult<Awaited<ReturnType<typeof media.listMedia>>>> {
  return runAction(slug, (scope) => media.listMedia(scope, input ?? {}));
}
