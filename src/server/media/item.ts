import type { MediaItem, VideoContainer, VideoFacts } from "../../providers/types";

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
  /** The facts of entry 24; absent on a row selected without them (the planner then treats them as unknown). */
  videoBitrate?: number | null;
  audioBitrate?: number | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  indexAtFront?: boolean | null;
  factsVersion?: number;
  factsAttempts?: number;
}

/** The entry-24 facts a row carries, left out entirely when the row was selected without them. */
function formatterFacts(row: ItemRow): Partial<VideoFacts> {
  const out: Partial<VideoFacts> = {};
  if (row.videoBitrate !== undefined) out.videoBitrate = row.videoBitrate;
  if (row.audioBitrate !== undefined) out.audioBitrate = row.audioBitrate;
  if (row.audioSampleRate !== undefined) out.audioSampleRate = row.audioSampleRate;
  if (row.audioChannels !== undefined) out.audioChannels = row.audioChannels;
  if (row.indexAtFront !== undefined) out.indexAtFront = row.indexAtFront;
  if (row.factsVersion !== undefined) {
    out.factsVersion = row.factsVersion === 1 ? 1 : 2;
    // Three failed rescans: the planner refuses rather than waits (P9).
    if (row.factsVersion === 1 && (row.factsAttempts ?? 0) >= 3) out.factsUnreadable = true;
  }
  return out;
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
            ...formatterFacts(row),
          },
        }
      : {}),
  };
}
