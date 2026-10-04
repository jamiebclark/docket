import type { StepContent, StepInfo } from "../types";
import { INSTAGRAM_MAX_IMAGES } from "./capabilities";
import { initialState, instagramStateSchema, type InstagramState } from "./state";

export const INVALID_STEP: StepInfo = { name: "invalid", mayPublish: false };

/** The parsed state when it is valid for `count` images, else null (restart from the first create step). */
export function validState(state: unknown, count: number): InstagramState | null {
  if (state === null || state === undefined) return null;
  const parsed = instagramStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.mediaType !== (count === 1 ? "IMAGE" : "CAROUSEL")) return null;
  if (s.items.length > count) return null;
  if (s.ready && !s.container) return null;
  if (s.quotaChecked && !s.ready) return null;
  return s;
}

/** Pure and total (data-model §4). */
export function instagramStepFor(state: unknown, content: StepContent): StepInfo {
  const count = Number.isFinite(content?.mediaCount) ? Math.max(0, Math.floor(content.mediaCount)) : 0;
  if (count === 0 || count > INSTAGRAM_MAX_IMAGES) return INVALID_STEP;
  const s = validState(state, count) ?? initialState(count);
  if (s.container === null) {
    if (s.mediaType === "IMAGE") return { name: "create_container", mayPublish: false };
    if (s.items.length < count) return { name: `create_item_${s.items.length + 1}`, mayPublish: false };
    return { name: "create_carousel", mayPublish: false };
  }
  if (!s.ready) return { name: "check_status", mayPublish: false };
  if (!s.quotaChecked) return { name: "check_quota", mayPublish: false };
  return { name: "publish", mayPublish: true };
}
