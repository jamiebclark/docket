import type { StepInfo } from "../types";

/** contracts/pinterest-publishing.md §3: pure and total, no state (K3). One request either publishes or it doesn't. */
export function pinterestStepFor(_state: unknown): StepInfo {
  return { name: "create_pin", mayPublish: true };
}
