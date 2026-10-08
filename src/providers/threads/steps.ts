import type { StepContent, StepInfo } from "../types";
import { initialState, mediaTypeFor, planOf, threadsStateSchema, type ThreadsPlan, type ThreadsState } from "./state";

export { planOf };

export const INVALID_STEP: StepInfo = { name: "invalid", mayPublish: false };

const sameKinds = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === undefined || b === undefined ? a === b : a.length === b.length && a.every((k, i) => k === b[i]);

/** The parsed state when it fits the plan (or a count of images), else null (restart from the first create step). */
export function validState(state: unknown, input: ThreadsPlan | number): ThreadsState | null {
  if (state === null || state === undefined) return null;
  const parsed = threadsStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const s = parsed.data;
  const plan: ThreadsPlan = typeof input === "number" ? { mediaType: mediaTypeFor(input), count: input } : input;
  const count = plan.count;
  if (s.mediaType !== plan.mediaType) return null;
  if (s.items.length > count) return null;
  if (s.mediaType !== "CAROUSEL" && (s.items.length > 0 || s.kinds || s.itemProgress)) return null;
  if (s.ready && !s.container) return null;
  if (s.quotaChecked && !s.ready) return null;
  if (s.mediaType === "CAROUSEL") {
    if (!sameKinds(s.kinds, plan.kinds)) return null;
    if (s.container && s.items.length < count) return null;
    if (s.kinds) {
      if (s.itemProgress?.length !== s.items.length) return null;
      if (s.container && s.itemProgress.some((p) => !p.ready)) return null;
    } else if (s.itemProgress) return null;
  }
  return s;
}

/** Pure and total (data-model §3). */
export function threadsStepFor(state: unknown, content: StepContent): StepInfo {
  const plan = planOf(content?.mediaCount, content?.kinds);
  if (!plan) return INVALID_STEP;
  const s = validState(state, plan) ?? initialState(plan);
  if (s.container === null) {
    if (s.mediaType !== "CAROUSEL") return { name: "create_container", mayPublish: false };
    if (s.items.length < plan.count) return { name: `create_item_${s.items.length + 1}`, mayPublish: false };
    const unready = s.itemProgress?.findIndex((p) => !p.ready) ?? -1;
    if (unready >= 0) return { name: `check_item_${unready + 1}`, mayPublish: false };
    return { name: "create_carousel", mayPublish: false };
  }
  if (!s.ready) return { name: "check_status", mayPublish: false };
  if (!s.quotaChecked) return { name: "check_quota", mayPublish: false };
  return { name: "publish", mayPublish: true };
}
