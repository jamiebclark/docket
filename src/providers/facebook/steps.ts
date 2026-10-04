import type { StepContent, StepInfo } from "../types";
import { FACEBOOK_MAX_IMAGES } from "./capabilities";
import { facebookStateSchema } from "./settings";

export const INVALID_STEP: StepInfo = { name: "invalid", mayPublish: false };

/** Pure and total (data-model §4). */
export function facebookStepFor(state: unknown, content: StepContent): StepInfo {
  const count = Number.isFinite(content?.mediaCount) ? Math.max(0, Math.floor(content.mediaCount)) : 0;
  let photoIds: string[] = [];
  if (state !== null && state !== undefined) {
    const parsed = facebookStateSchema.safeParse(state);
    if (!parsed.success) return INVALID_STEP;
    photoIds = parsed.data.photoIds;
  }
  if (count > FACEBOOK_MAX_IMAGES || photoIds.length > count) return INVALID_STEP;
  if (count === 0) return { name: "publish_feed", mayPublish: true };
  if (count === 1) return { name: "publish_photo", mayPublish: true };
  if (photoIds.length < count) return { name: `upload_photo_${photoIds.length + 1}`, mayPublish: false };
  return { name: "publish_feed", mayPublish: true };
}
