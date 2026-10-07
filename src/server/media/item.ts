import type { MediaItem, VideoContainer } from "../../providers/types";

/** The columns of a media row that a provider-facing item needs. */
export interface ItemRow {
  kind: string;
  processingState: string;
  processingError: string | null;
  durationMs: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
}

/** `kind`, `status`, `failureReason` and (for a ready video) `video`, to merge into a `MediaItem`. */
export function videoFieldsOf(row: ItemRow): Pick<MediaItem, "kind" | "status" | "failureReason" | "video"> {
  if (row.kind !== "video") return {};
  const status = row.processingState === "processing" || row.processingState === "failed" ? row.processingState : "ready";
  return {
    kind: "video",
    status,
    ...(status === "failed" && row.processingError ? { failureReason: row.processingError } : {}),
    ...(status === "ready" && row.durationMs !== null && row.videoCodec && row.container
      ? {
          video: {
            container: (row.container === "mov" ? "mov" : "mp4") satisfies VideoContainer,
            durationSeconds: row.durationMs / 1000,
            frameRate: row.frameRate,
            videoCodec: row.videoCodec,
            audioCodec: row.audioCodec,
          },
        }
      : {}),
  };
}
