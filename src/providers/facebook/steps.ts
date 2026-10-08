import type { StepContent, StepInfo } from "../types";
import { FACEBOOK_MAX_IMAGES } from "./capabilities";
import { photoStateSchema } from "./settings";
import { validReelState } from "./state";

export const INVALID_STEP: StepInfo = { name: "invalid", mayPublish: false };
const INVALID_AFTER_PUBLISH: StepInfo = { name: "invalid", mayPublish: false, afterPublish: true };

/** Pure and total (data-model §3). */
export function facebookStepFor(state: unknown, content: StepContent): StepInfo {
  const count = Number.isFinite(content?.mediaCount) ? Math.max(0, Math.floor(content.mediaCount)) : 0;
  const isVideo = count === 1 && content?.kinds?.[0] === "video";
  const hasState = state !== null && state !== undefined;
  const reel = hasState ? validReelState(state) : null;
  if (reel?.finishedAt) return { name: "check_publish", mayPublish: false, afterPublish: true };
  const photo = hasState && !reel ? photoStateSchema.safeParse(state) : null;
  if (hasState && !reel && !photo?.success) return isVideo ? INVALID_AFTER_PUBLISH : INVALID_STEP;
  if (isVideo) {
    if (content.postType !== "reel") return { name: "publish_video", mayPublish: true };
    if (!reel) return { name: "start_reel", mayPublish: false, allowance: { units: 1, retryUnits: 1 } };
    if (reel.uploadedAt === null) return { name: "upload_reel", mayPublish: false };
    if (!reel.uploadComplete) return { name: "check_upload", mayPublish: false };
    return { name: "finish_reel", mayPublish: true };
  }
  const photoIds = photo?.success ? photo.data.photoIds : [];
  if (count > FACEBOOK_MAX_IMAGES || photoIds.length > count) return INVALID_STEP;
  if (count === 0) return { name: "publish_feed", mayPublish: true };
  if (count === 1) return { name: "publish_photo", mayPublish: true };
  if (photoIds.length < count) return { name: `upload_photo_${photoIds.length + 1}`, mayPublish: false };
  return { name: "publish_feed", mayPublish: true };
}
