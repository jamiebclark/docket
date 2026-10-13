import { and, eq, inArray, isNotNull, notInArray, sql, type SQL } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { generationJobs, projectLlmSettings } from "../db/schema";

/** The install's env-configured credential: the only credential owner that exists today (C7). */
export const INSTALL_CREDENTIAL_OWNER = "install";

/** Prefix of every project's own credential owner string. Shared so a `LIKE`/`substring` elsewhere (see
 * `pruneOrphanCreditHolds`) stays in lockstep with `projectCredentialOwner`. */
export const PROJECT_CREDENTIAL_OWNER_PREFIX = "project:";

/** The owner string for a project's own stored credential (FR-012, FR-027). The one place that formats it. */
export function projectCredentialOwner(projectId: string): string {
  return `${PROJECT_CREDENTIAL_OWNER_PREFIX}${projectId}`;
}

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
  return rows.length > 0 ? projectCredentialOwner(projectId) : INSTALL_CREDENTIAL_OWNER;
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
  for (const row of rows) owners.set(row.projectId, projectCredentialOwner(row.projectId));
  return owners;
}

/**
 * A predicate over `generation_jobs` keeping only jobs whose project id is not in `projectIds` (already
 * resolved from the blocked owners — see `job-claims.ts`'s `resolveBlockedProjectIds`, which asks
 * `credentialOwnerFor` about each candidate project, a genuine per-owner lookup rather than an
 * all-or-nothing guess, SC-010). `undefined` when `projectIds` is empty, so the claim's statement is
 * unchanged with no hold in place.
 */
export function jobsExcludingProjects(projectIds: readonly string[], allBlocked = false): SQL | undefined {
  if (projectIds.length === 0) return undefined;
  // Every project that has an active job is blocked, so the claim cannot match anything: say so with one
  // constant rather than a bind parameter per project. The list is still used for the mixed case, which is
  // the one that matters once projects own credentials (review F5).
  if (allBlocked) return sql`false`;
  return notInArray(generationJobs.projectId, [...projectIds]);
}
