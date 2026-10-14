import { and, eq, inArray, isNotNull, notInArray, sql, type SQL } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { generationJobs, projectLlmSettings, standingSeries } from "../db/schema";
// Self-imported so a test's `vi.spyOn(credentialOwners, "credentialOwnersFor")` reaches this module's own
// call below: a bare reference to the local const would bypass the mocked export entirely.
import * as self from "./credential-owners";

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
 * Resolves `owners` to the subset of `candidateProjectIds` whose credential owner is one of them, by
 * asking `credentialOwnersFor` about every candidate in one round trip — a genuine per-owner lookup
 * rather than an all-or-nothing guess (SC-010). The candidate list is the caller's: job claims pass
 * the projects with an active job, the standing-series claim passes the projects with an enabled
 * series (S37), so neither claim's own statement count grows with the other's rows.
 */
export async function resolveBlockedProjectIds(
  exec: Database,
  owners: readonly string[],
  candidateProjectIds: readonly string[],
): Promise<{ ids: string[]; allBlocked: boolean }> {
  if (owners.length === 0 || candidateProjectIds.length === 0) return { ids: [], allBlocked: false };
  const blocked = new Set(owners);
  const ownersByProject = await self.credentialOwnersFor(candidateProjectIds, exec);
  const ids = candidateProjectIds.filter((id) => blocked.has(ownersByProject.get(id) ?? INSTALL_CREDENTIAL_OWNER));
  return { ids, allBlocked: ids.length > 0 && ids.length === candidateProjectIds.length };
}

/**
 * A predicate over `generation_jobs` keeping only jobs whose project id is not in `projectIds` (already
 * resolved from the blocked owners — see `resolveBlockedProjectIds`). `undefined` when `projectIds` is
 * empty, so the claim's statement is unchanged with no hold in place.
 */
export function jobsExcludingProjects(projectIds: readonly string[], allBlocked = false): SQL | undefined {
  if (projectIds.length === 0) return undefined;
  // Every project that has an active job is blocked, so the claim cannot match anything: say so with one
  // constant rather than a bind parameter per project. The list is still used for the mixed case, which is
  // the one that matters once projects own credentials (review F5).
  if (allBlocked) return sql`false`;
  return notInArray(generationJobs.projectId, [...projectIds]);
}

/** The same predicate, over `standing_series` (S37). */
export function standingSeriesExcludingProjects(projectIds: readonly string[], allBlocked = false): SQL | undefined {
  if (projectIds.length === 0) return undefined;
  if (allBlocked) return sql`false`;
  return notInArray(standingSeries.projectId, [...projectIds]);
}
