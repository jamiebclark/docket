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

/** Append-only by design: insert and list, nothing else (FR-033). */
export interface AuditRepo {
  insert(entry: AuditEntry): Promise<void>;
  list(opts?: { limit?: number }): Promise<AuditRow[]>;
}

export function createAuditRepo(db: Database, projectId: string): AuditRepo {
  return {
    async insert(entry) {
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
