import type { StepContent, StepInfo } from "../types";
import { THREADS_MAX_IMAGES } from "./capabilities";
import { initialState, mediaTypeFor, threadsStateSchema, type ThreadsState } from "./state";

export const INVALID_STEP: StepInfo = { name: "invalid", mayPublish: false };

/** The parsed state when it fits `count` images, else null (restart from the first create step). */
export function validState(state: unknown, count: number): ThreadsState | null {
  if (state === null || state === undefined) return null;
  const parsed = threadsStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.mediaType !== mediaTypeFor(count)) return null;
  if (s.items.length > count) return null;
  if (s.mediaType !== "CAROUSEL" && s.items.length > 0) return null;
  if (s.ready && !s.container) return null;
  if (s.quotaChecked && !s.ready) return null;
  if (s.mediaType === "CAROUSEL" && s.container && s.items.length < count) return null;
  return s;
}

/** Pure and total (data-model §5). */
export function threadsStepFor(state: unknown, content: StepContent): StepInfo {
  const raw = content?.mediaCount;
  const count = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (typeof raw !== "number" || !Number.isFinite(raw) || count > THREADS_MAX_IMAGES) return INVALID_STEP;
  const s = validState(state, count) ?? initialState(count);
  if (s.container === null) {
    if (s.mediaType !== "CAROUSEL") return { name: "create_container", mayPublish: false };
    if (s.items.length < count) return { name: `create_item_${s.items.length + 1}`, mayPublish: false };
    return { name: "create_carousel", mayPublish: false };
  }
  if (!s.ready) return { name: "check_status", mayPublish: false };
  if (!s.quotaChecked) return { name: "check_quota", mayPublish: false };
  return { name: "publish", mayPublish: true };
}
