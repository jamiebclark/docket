import { docsUrl } from "@/lib/docs";
import { ratioLabel } from "../video-labels";
import { THREADS_VIDEO } from "./capabilities";
import { VIDEO_PROCESSING_CAP_MS } from "./state";

// "INVALID_ASPEC_RATIO" is spelled as Threads spells it (docs/research/meta-video.md); the corrected spelling is not matched.
export const THREADS_VIDEO_ERROR_CODES = [
  "FAILED_DOWNLOADING_VIDEO",
  "FAILED_PROCESSING_VIDEO",
  "INVALID_DURATION",
  "INVALID_FRAME_RATE",
  "INVALID_BIT_RATE",
  "INVALID_ASPEC_RATIO",
] as const;
type Code = (typeof THREADS_VIDEO_ERROR_CODES)[number];

const explanations = (): Record<Code, string> => ({
  FAILED_DOWNLOADING_VIDEO: `Threads could not fetch the video; media storage must be publicly readable (see ${docsUrl("storage")}).`,
  FAILED_PROCESSING_VIDEO: "Threads could not process the file, usually because of its encoding.",
  INVALID_DURATION: `Threads videos can be at most ${THREADS_VIDEO.maxDurationSeconds} seconds.`,
  INVALID_FRAME_RATE: `Threads videos must be ${THREADS_VIDEO.minFrameRate} to ${THREADS_VIDEO.maxFrameRate} frames per second.`,
  INVALID_BIT_RATE: "The video's bitrate is above Threads' limit, which Docket does not check.",
  INVALID_ASPEC_RATIO: `Threads videos must have an aspect ratio between ${ratioLabel(THREADS_VIDEO.minAspectRatio)} and ${ratioLabel(THREADS_VIDEO.maxAspectRatio)}.`,
});

const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** The plain explanation for the first documented code in the message (whole token, case-sensitive), else null. */
export function videoErrorExplanation(errorMessage: string): string | null {
  let best: { at: number; code: Code } | null = null;
  for (const code of THREADS_VIDEO_ERROR_CODES) {
    let from = 0;
    for (;;) {
      const at = errorMessage.indexOf(code, from);
      if (at < 0) break;
      if (!isWordChar(errorMessage[at - 1]) && !isWordChar(errorMessage[at + code.length])) {
        if (!best || at < best.at) best = { at, code };
        break;
      }
      from = at + 1;
    }
  }
  return best ? explanations()[best.code] : null;
}

export type VideoWhere = { kind: "single" } | { kind: "item"; position: number } | { kind: "carousel" };

const WHAT = (where: VideoWhere) =>
  where.kind === "single"
    ? "the video"
    : where.kind === "item"
      ? `the video in item ${where.position} of the carousel`
      : "the video carousel";

/** The full message for an `ERROR` on a video container (contracts/threads-publishing.md §5). */
export function videoErrorText(where: VideoWhere, errorMessage: string): string {
  const reason = errorMessage.trim().replace(/\.$/, "");
  const explanation = reason ? videoErrorExplanation(reason) : null;
  return `Threads could not process ${WHAT(where)}${reason ? `: ${reason}.` : " (status ERROR)."}${explanation ? ` ${explanation}` : ""} Nothing was published; retry the post after fixing the video.`;
}

/** Shown when a video is still processing at the ceiling. */
export const VIDEO_CEILING_TEXT = `Threads did not finish processing the video within ${VIDEO_PROCESSING_CAP_MS / 60_000} minutes; nothing was published. Retry the post to try again.`;
