// generation/index: the public surface of the generation services.
export { runGeneration, type CoreOutcome, type CoreRequest } from "./core";
export {
  applyApprovalPolicy,
  decidePolicy,
  resolvePolicies,
  type PolicyDecision,
  type ResolvedPolicies,
} from "./policy";
export { listRecentFailures, recordFailure } from "./failures";
export { generateSingle, generateSingleSchema, type GenerateResult } from "./single";
export { regeneratePost } from "./regenerate";
