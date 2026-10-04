import type { ApiMedia } from "@/lib/api/schemas";
import type { MediaView } from "../media";

export function toApiMedia(m: MediaView): ApiMedia {
  return {
    id: m.id,
    url: m.publicUrl,
    thumbnailUrl: m.thumbnailUrl || null,
    mimeType: m.mimeType,
    width: m.width,
    height: m.height,
    byteSize: m.byteSize,
    altText: m.altText,
    tags: m.tags,
    used: m.inUse,
    reservedByJobId: m.reservedByJobId,
    createdAt: m.createdAt.toISOString(),
  };
}
