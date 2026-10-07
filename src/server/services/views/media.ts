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
    kind: m.kind,
    processingState: m.status,
    processingError: m.processingError,
    video: m.video
      ? {
          durationSeconds: m.video.durationSeconds,
          frameRate: m.video.frameRate,
          videoCodec: m.video.videoCodec,
          audioCodec: m.video.audioCodec,
          container: m.video.container,
        }
      : null,
    createdAt: m.createdAt.toISOString(),
  };
}
