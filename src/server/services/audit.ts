import type { ProjectScope } from "../dal/scope";
import type { AuditEntry } from "../dal/audit";

// Details must never carry secrets (SC-009): refuse them rather than trust callers.
const FORBIDDEN_KEY = /token|url|password|secret/i;

function assertSafe(details: Record<string, unknown> | undefined): void {
  for (const key of Object.keys(details ?? {})) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`Audit details must not include "${key}"`);
    }
  }
}

/** Writes a membership audit row for the scope's project. Call inside the same transaction as the change. */
export async function recordAudit(scope: ProjectScope, entry: AuditEntry): Promise<void> {
  assertSafe(entry.details);
  await scope.audit.insert(entry);
}
