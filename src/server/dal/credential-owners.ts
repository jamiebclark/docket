import { notInArray, type SQL } from "drizzle-orm";
import { generationJobs } from "../db/schema";

/** The install's env-configured credential: the only credential owner that exists today (C7). */
export const INSTALL_CREDENTIAL_OWNER = "install";

/**
 * Who owns the credential a call for this project would spend (FR-012).
 * Today: the install's one credential, whatever the project. Entry 2 (per-project-llm) changes only
 * this function and the owner values it returns — nothing else in the hold, the probe, the claim or the
 * notices moves (SC-010).
 * Async on purpose: entry 2 must read the project's stored credential to answer.
 */
export async function credentialOwnerFor(_projectId: string): Promise<string> {
  return INSTALL_CREDENTIAL_OWNER;
}

/**
 * A predicate over `generation_jobs` keeping only jobs whose project id is not in `projectIds` (already
 * resolved from the blocked owners — see `job-claims.ts`'s `resolveBlockedProjectIds`, which asks
 * `credentialOwnerFor` about each candidate project, a genuine per-owner lookup rather than an
 * all-or-nothing guess, SC-010). `undefined` when `projectIds` is empty, so the claim's statement is
 * unchanged with no hold in place.
 */
export function jobsExcludingOwners(projectIds: readonly string[]): SQL | undefined {
  if (projectIds.length === 0) return undefined;
  return notInArray(generationJobs.projectId, [...projectIds]);
}
