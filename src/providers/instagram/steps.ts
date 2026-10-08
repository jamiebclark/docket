import type { StepContent, StepInfo } from "../types";
import { INSTAGRAM_MAX_IMAGES } from "./capabilities";
import { initialState, instagramStateSchema, type InstagramPlan, type InstagramState } from "./state";

export const INVALID_STEP: StepInfo = { name: "invalid", mayPublish: false };

type Kind = "image" | "video";

/** What the content publishes as, or null when it cannot (no media, or more than 10). Pure and total. */
export function planOf(content: Pick<StepContent, "mediaCount" | "kinds" | "postType">): InstagramPlan | null {
  const count = Number.isFinite(content?.mediaCount) ? Math.max(0, Math.floor(content.mediaCount)) : 0;
  if (count === 0 || count > INSTAGRAM_MAX_IMAGES) return null;
  const kinds: Kind[] = content.kinds && content.kinds.length === count ? [...content.kinds] : Array.from({ length: count }, () => "image");
  if (count === 1) {
    if (kinds[0] === "video") return { mediaType: "REELS", shareToFeed: content.postType !== "reel" };
    return { mediaType: "IMAGE" };
  }
  return { mediaType: "CAROUSEL", kinds };
}

const sameKinds = (a: readonly Kind[] | undefined, b: readonly Kind[]) => {
  const left = a ?? b.map(() => "image");
  return left.length === b.length && left.every((k, i) => k === b[i]);
};

/** The parsed state when it is valid for `plan`, else null (restart from the first create step). */
export function validState(state: unknown, plan: InstagramPlan): InstagramState | null {
  if (state === null || state === undefined) return null;
  const parsed = instagramStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.mediaType !== plan.mediaType) return null;
  if (plan.mediaType === "REELS" && s.shareToFeed !== plan.shareToFeed) return null;
  if (plan.mediaType === "CAROUSEL") {
    const kinds = plan.kinds ?? [];
    if (!sameKinds(s.kinds, kinds)) return null;
    if (s.items.length > kinds.length) return null;
    if (kinds.includes("video")) {
      if (s.itemProgress?.length !== s.items.length) return null;
      if (s.container !== null && !s.itemProgress.every((p) => p.ready)) return null;
    }
    if (s.container !== null && s.items.length !== kinds.length) return null;
  }
  if (s.ready && !s.container) return null;
  if (s.quotaChecked && !s.ready) return null;
  return s;
}

/** Pure and total (data-model §4). */
export function instagramStepFor(state: unknown, content: StepContent): StepInfo {
  const plan = planOf(content);
  if (!plan) return INVALID_STEP;
  const s = validState(state, plan) ?? initialState(plan);
  const step = (name: string, units: number, retryUnits = 1): StepInfo => ({ name, mayPublish: false, allowance: { units, retryUnits } });
  if (s.container === null) {
    if (plan.mediaType !== "CAROUSEL") return step("create_container", 1);
    const kinds = plan.kinds ?? [];
    if (s.items.length < kinds.length) return step(`create_item_${s.items.length + 1}`, s.items.length === 0 ? kinds.length + 1 : 0);
    const unready = s.itemProgress?.findIndex((p) => !p.ready) ?? -1;
    if (unready >= 0) return { name: `check_item_${unready + 1}`, mayPublish: false };
    return step("create_carousel", 0);
  }
  if (!s.ready) return { name: "check_status", mayPublish: false };
  if (!s.quotaChecked) return { name: "check_quota", mayPublish: false };
  return { name: "publish", mayPublish: true };
}
