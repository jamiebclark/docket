import type { UsagePurpose } from "../../server/llm/usage";

/** The human label shown on the Usage screen, keyed by the seven enum values verbatim. */
export const USAGE_PURPOSE_LABELS: Record<UsagePurpose, string> = {
  "generate.single": "Single post",
  "generate.series_plan": "Series plan",
  "generate.series_post": "Series post",
  "generate.regenerate": "Regenerate",
  "generate.job_item": "Batch job item",
  "voice.try": "Voice try it",
  "llm.check": "Credential check",
};
