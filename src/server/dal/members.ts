import { and, asc, count, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { member, user } from "../db/schema";

export interface MemberRow {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: Date;
}

/** Membership queries pinned to one project (`organization_id = projectId`). */
export interface MembersRepo {
  find(userId: string): Promise<{ memberId: string; role: string } | null>;
  findByEmail(email: string): Promise<{ memberId: string; role: string } | null>;
  insertOwner(userId: string): Promise<{ memberId: string }>;
  insert(userId: string, role: string): Promise<{ memberId: string }>;
  list(): Promise<MemberRow[]>;
  updateRole(userId: string, role: string): Promise<void>;
  delete(userId: string): Promise<void>;
  /** Only meaningful inside a `lockProject` transaction, which serialises owner changes. */
  countOwners(): Promise<number>;
  /**
   * Locks the caller's own `member` row with `FOR NO KEY UPDATE`, in its own statement. Serialises one
   * member's concurrent `createUpload` calls for the open-upload cap. Only meaningful inside a transaction.
   */
  lockSelf(userId: string): Promise<boolean>;
}

export function createMembersRepo(db: Database, projectId: string): MembersRepo {
  return {
    async find(userId) {
      const [row] = await db
        .select({ memberId: member.id, role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, projectId), eq(member.userId, userId)))
        .limit(1);
      return row ?? null;
    },
    async findByEmail(email) {
      const [row] = await db
        .select({ memberId: member.id, role: member.role })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, projectId), eq(user.email, email.trim().toLowerCase())))
        .limit(1);
      return row ?? null;
    },
    async insertOwner(userId) {
      return this.insert(userId, "owner");
    },
    async insert(userId, role) {
      const [row] = await db
        .insert(member)
        .values({ organizationId: projectId, userId, role })
        .returning({ memberId: member.id });
      if (!row) throw new Error("Member insert returned no row");
      return row;
    },
    async updateRole(userId, role) {
      await db
        .update(member)
        .set({ role })
        .where(and(eq(member.organizationId, projectId), eq(member.userId, userId)));
    },
    async delete(userId) {
      await db.delete(member).where(and(eq(member.organizationId, projectId), eq(member.userId, userId)));
    },
    async countOwners() {
      const [row] = await db
        .select({ n: count() })
        .from(member)
        .where(and(eq(member.organizationId, projectId), eq(member.role, "owner")));
      return row?.n ?? 0;
    },
    async lockSelf(userId) {
      const rows = await db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, projectId), eq(member.userId, userId)))
        .limit(1)
        .for("no key update");
      return rows.length > 0;
    },
    async list() {
      return db
        .select({
          memberId: member.id,
          userId: member.userId,
          name: user.name,
          email: user.email,
          role: member.role,
          joinedAt: member.createdAt,
        })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, projectId))
        .orderBy(asc(member.createdAt));
    },
  };
}
