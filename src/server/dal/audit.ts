import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { membershipAuditLog } from "../db/schema";

export type MembershipAction = (typeof membershipAuditLog.$inferInsert)["action"];

export interface AuditEntry {
  action: MembershipAction;
  actorUserId: string | null;
  subjectUserId?: string | null;
  subjectEmail?: string | null;
  details?: Record<string, unknown>;
}

export type AuditRow = typeof membershipAuditLog.$inferSelect;

// Details must never carry secrets (SC-009, FR-027): refuse them here, at the only write path, rather than trust callers.
const FORBIDDEN_KEY = /token|url|password|secret/i;

export function assertAuditDetailsSafe(details: Record<string, unknown> | undefined): void {
  for (const key of Object.keys(details ?? {})) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`Audit details must not include "${key}"`);
  }
}

/** Append-only by design: insert and list, nothing else (FR-033). */
export interface AuditRepo {
  insert(entry: AuditEntry): Promise<void>;
  list(opts?: { limit?: number }): Promise<AuditRow[]>;
}

export function createAuditRepo(db: Database, projectId: string): AuditRepo {
  return {
    async insert(entry) {
      assertAuditDetailsSafe(entry.details);
      await db.insert(membershipAuditLog).values({
        projectId,
        actorUserId: entry.actorUserId,
        action: entry.action,
        subjectUserId: entry.subjectUserId ?? null,
        subjectEmail: entry.subjectEmail ?? null,
        details: entry.details ?? {},
      });
    },
    async list({ limit = 100 } = {}) {
      return db
        .select()
        .from(membershipAuditLog)
        .where(and(eq(membershipAuditLog.projectId, projectId)))
        .orderBy(desc(membershipAuditLog.createdAt))
        .limit(limit);
    },
  };
}
