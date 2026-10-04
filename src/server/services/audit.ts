import type { ProjectScope } from "../dal/scope";
import type { AuditEntry } from "../dal/audit";

/** Writes a membership audit row for the scope's project. Call inside the same transaction as the change. */
export async function recordAudit(scope: ProjectScope, entry: AuditEntry): Promise<void> {
  // The repo refuses secret-looking detail keys itself, so no write path can skip the guard.
  await scope.audit.insert(entry);
}
