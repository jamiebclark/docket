import type { StepContent, StepInfo } from "../types";
import { parseTikTokState, type TikTokState } from "./state";

const isVideo = (content: StepContent): boolean => (content?.videoCount ?? 0) > 0 || content?.postType === "video";

/** Pure and total (data-model §6). Only the last chunk and a photo post may publish; `check_status` follows publishing. */
export function tiktokStepFor(state: unknown, _settings: unknown, content: StepContent): StepInfo {
  const check: StepInfo = { name: "check_creator", mayPublish: false };
  if (state === null || state === undefined) return check;

  const parsed = parseTikTokState(state);
  if (!parsed) {
    const raw = state as { publishId?: unknown; sentAt?: unknown };
    if (typeof raw === "object" && typeof raw.publishId === "string" && typeof raw.sentAt === "string") return { name: "check_status", mayPublish: false, afterPublish: true };
    return check;
  }
  if (parsed.phase === "status") return { name: "check_status", mayPublish: false, afterPublish: true };
  if (parsed.kind !== (isVideo(content) ? "video" : "photo")) return check;
  return stepForPhase(parsed);
}

function stepForPhase(s: TikTokState): StepInfo {
  switch (s.phase) {
    case "start":
      return s.kind === "video" ? { name: "start_upload", mayPublish: false } : { name: "publish_photos", mayPublish: true };
    case "chunks": {
      const next = (s.chunksSent ?? 0) + 1;
      return { name: `upload_chunk_${next}`, mayPublish: next === s.chunkCount };
    }
    default:
      return { name: "check_creator", mayPublish: false };
  }
}
