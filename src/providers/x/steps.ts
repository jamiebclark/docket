import type { StepContent, StepInfo } from "../types";
import { parseXState } from "./state";

/** Pure and total (data-model §5). The conditions are checked in the order of the table. */
export function xStepFor(state: unknown, _settings: unknown, content: StepContent): StepInfo {
  const raw = Number(content?.mediaCount);
  const n = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (n === 0) return { name: "create_post", mayPublish: true };

  const parsed = state === null || state === undefined ? null : parseXState(state);
  if (!parsed || parsed.mediaCount !== n || parsed.images.length > n) return { name: "upload_image_1", mayPublish: false };

  const k = parsed.images.length;
  const last = parsed.images[k - 1];
  if (last?.processing === "pending") return { name: `check_image_${k}`, mayPublish: false };
  if (last && last.alt && !last.described) return { name: `describe_image_${k}`, mayPublish: false };
  if (k < n) return { name: `upload_image_${k + 1}`, mayPublish: false };
  return { name: "create_post", mayPublish: true };
}
