import type { StepContent, StepInfo } from "../types";

// Stub (T002): total placeholder until the publish steps land; replaced by the real step map in a later task.
export function threadsStepFor(_state: unknown, _content: StepContent): StepInfo {
  return { name: "create", mayPublish: false };
}
