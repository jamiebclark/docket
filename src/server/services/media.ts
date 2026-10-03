import { z } from "zod";
import { registerAssetSchema } from "@/lib/validation/scheduling";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import type { MediaRow } from "../dal/media";
import type { ProjectScope } from "../dal/scope";

/** Registration only; storage is entry 3. */
export async function registerAsset(scope: ProjectScope, input: unknown): Promise<MediaRow> {
  const parsed = registerAssetSchema.parse(input);
  if (!scope.can({ media: ["edit"] })) throw new ForbiddenError();
  return scope.transaction(async (tx) => {
    if (!tx.can({ media: ["edit"] })) throw new ForbiddenError();
    return tx.media.insert({
      storageKey: parsed.storageKey,
      publicUrl: parsed.publicUrl,
      mimeType: parsed.mimeType,
      byteSize: parsed.byteSize,
      width: parsed.width ?? null,
      height: parsed.height ?? null,
      ...(parsed.altText !== undefined ? { altText: parsed.altText } : {}),
      createdByUserId: tx.membership.userId,
    });
  });
}

export async function updateAltText(scope: ProjectScope, assetId: string, altText: string): Promise<void> {
  const id = z.uuid().parse(assetId);
  const alt = z.string().max(2000).parse(altText);
  if (!scope.can({ media: ["edit"] })) throw new ForbiddenError();
  await scope.transaction(async (tx) => {
    if (!tx.can({ media: ["edit"] })) throw new ForbiddenError();
    if (!(await tx.media.get(id))) throw new NotFoundError();
    await tx.media.updateAlt(id, alt);
  });
}
