import { and, eq, inArray, isNotNull, notInArray, type SQL } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { generationJobs, projectLlmSettings } from "../db/schema";

/** The install's env-configured credential: the only credential owner that exists today (C7). */
export const INSTALL_CREDENTIAL_OWNER = "install";

/**
 * Who owns the credential a call for this project would spend (FR-012, FR-024).
 * The install's one credential, unless the project has set its own.
 * Async on purpose: it reads the project's stored credential to answer.
 */
export async function credentialOwnerFor(projectId: string, exec: Database = getDb()): Promise<string> {
  const rows = await exec
    .select({ projectId: projectLlmSettings.projectId })
    .from(projectLlmSettings)
    .where(and(eq(projectLlmSettings.projectId, projectId), isNotNull(projectLlmSettings.provider)))
    .limit(1);
  return rows.length > 0 ? `project:${projectId}` : INSTALL_CREDENTIAL_OWNER;
}

/** The same question for many projects, in one statement (L10). */
export async function credentialOwnersFor(
  projectIds: readonly string[],
  exec: Database = getDb(),
): Promise<Map<string, string>> {
  const owners = new Map<string, string>(projectIds.map((id) => [id, INSTALL_CREDENTIAL_OWNER]));
  if (projectIds.length === 0) return owners;
  const rows = await exec
    .select({ projectId: projectLlmSettings.projectId })
    .from(projectLlmSettings)
    .where(and(inArray(projectLlmSettings.projectId, [...projectIds]), isNotNull(projectLlmSettings.provider)));
  for (const row of rows) owners.set(row.projectId, `project:${row.projectId}`);
  return owners;
}

/**
 * A predicate over `generation_jobs` keeping only jobs whose project id is not in `projectIds` (already
 * resolved from the blocked owners — see `job-claims.ts`'s `resolveBlockedProjectIds`, which asks
 * `credentialOwnerFor` about each candidate project, a genuine per-owner lookup rather than an
 * all-or-nothing guess, SC-010). `undefined` when `projectIds` is empty, so the claim's statement is
 * unchanged with no hold in place.
 */
export function jobsExcludingProjects(projectIds: readonly string[]): SQL | undefined {
  if (projectIds.length === 0) return undefined;
  return notInArray(generationJobs.projectId, [...projectIds]);
}
