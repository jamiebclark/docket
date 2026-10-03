import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import { account, invitation, projects, user } from "../db/schema";
import { createAuditRepo, type AuditRepo } from "./audit";
import { createMembersRepo, type MembersRepo } from "./members";
import { createTokensRepo, type TokensRepo } from "./tokens";

export type InvitationRow = typeof invitation.$inferSelect;
export type InvitationStatus = "pending" | "accepted" | "rejected" | "canceled";

export interface InvitationListRow extends InvitationRow {
  inviterName: string;
}

/** Invitation queries pinned to one project (`organization_id = projectId`). */
export interface InvitationsRepo {
  insert(input: { email: string; role: string; inviterId: string; expiresAt: Date }): Promise<InvitationRow>;
  find(id: string): Promise<InvitationRow | null>;
  findPendingByEmail(email: string): Promise<InvitationRow | null>;
  setStatus(id: string, status: InvitationStatus): Promise<void>;
  resetExpiry(id: string, expiresAt: Date): Promise<void>;
  list(): Promise<InvitationListRow[]>;
}

export function createInvitationsRepo(db: Database, projectId: string): InvitationsRepo {
  const here = eq(invitation.organizationId, projectId);
  return {
    async insert(input) {
      const [row] = await db
        .insert(invitation)
        .values({ organizationId: projectId, ...input })
        .returning();
      if (!row) throw new Error("Invitation insert returned no row");
      return row;
    },
    async find(id) {
      const [row] = await db.select().from(invitation).where(and(here, eq(invitation.id, id))).limit(1);
      return row ?? null;
    },
    async findPendingByEmail(email) {
      const [row] = await db
        .select()
        .from(invitation)
        .where(and(here, eq(invitation.status, "pending"), eq(sql`lower(${invitation.email})`, email.toLowerCase())))
        .limit(1);
      return row ?? null;
    },
    async setStatus(id, status) {
      await db.update(invitation).set({ status }).where(and(here, eq(invitation.id, id)));
    },
    async resetExpiry(id, expiresAt) {
      await db.update(invitation).set({ expiresAt }).where(and(here, eq(invitation.id, id)));
    },
    async list() {
      const rows = await db
        .select({ invitation, inviterName: user.name })
        .from(invitation)
        .innerJoin(user, eq(user.id, invitation.inviterId))
        .where(here)
        .orderBy(desc(invitation.createdAt));
      return rows.map((r) => ({ ...r.invitation, inviterName: r.inviterName }));
    },
  };
}

/** Everything a service needs inside one transaction on one locked project. */
export interface ProjectTx {
  projectId: string;
  db: Database;
  invitations: InvitationsRepo;
  tokens: TokensRepo;
  members: MembersRepo;
  audit: AuditRepo;
}

export function buildProjectTx(db: Database, projectId: string): ProjectTx {
  return {
    projectId,
    db,
    invitations: createInvitationsRepo(db, projectId),
    tokens: createTokensRepo(db, projectId),
    members: createMembersRepo(db, projectId),
    audit: createAuditRepo(db, projectId),
  };
}

/** Runs `fn` in a transaction holding the project row lock (research D12). */
export async function withLockedProject<T>(
  projectId: string,
  fn: (tx: ProjectTx) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    return fn(buildProjectTx(tx, projectId));
  });
}

export interface InvitationLookup {
  id: string;
  projectId: string;
  projectSlug: string;
  email: string;
  status: string;
}

/** Finds an invitation by id for a caller who is not (yet) a member. Cross-project. */
export function lookupInvitation(id: string, db: Database = getDb()): Promise<InvitationLookup | null> {
  return runCrossProject("resolve invitation by id", async () => {
    const [row] = await db
      .select({
        id: invitation.id,
        projectId: projects.id,
        projectSlug: projects.slug,
        email: invitation.email,
        status: invitation.status,
      })
      .from(invitation)
      .innerJoin(projects, eq(projects.id, invitation.organizationId))
      .where(eq(invitation.id, id))
      .limit(1);
    return row ?? null;
  });
}

export interface PendingInvitationRow {
  id: string;
  projectName: string;
  projectSlug: string;
  role: string;
  inviterName: string;
  expiresAt: Date;
}

/** Pending, unexpired invitations addressed to `email`. Cross-project (by the user's own email). */
export function listPendingForEmail(email: string, db: Database = getDb()): Promise<PendingInvitationRow[]> {
  return runCrossProject("list my invitations", async () =>
    db
      .select({
        id: invitation.id,
        projectName: projects.name,
        projectSlug: projects.slug,
        role: invitation.role,
        inviterName: user.name,
        expiresAt: invitation.expiresAt,
      })
      .from(invitation)
      .innerJoin(projects, eq(projects.id, invitation.organizationId))
      .innerJoin(user, eq(user.id, invitation.inviterId))
      .where(
        and(
          eq(sql`lower(${invitation.email})`, email.trim().toLowerCase()),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(invitation.expiresAt)),
  );
}

export async function userExistsByEmail(email: string, db: Database = getDb()): Promise<boolean> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email.trim().toLowerCase())).limit(1);
  return Boolean(row);
}

/** Creates the user and its credential account for an invited sign-up (inside the caller's transaction). */
export async function insertInvitedUser(
  db: Database,
  input: { name: string; email: string; passwordHash: string },
): Promise<{ id: string }> {
  const [created] = await db
    .insert(user)
    .values({ name: input.name, email: input.email, emailVerified: false })
    .returning({ id: user.id });
  if (!created) throw new Error("User insert returned no row");
  await db.insert(account).values({
    userId: created.id,
    accountId: created.id,
    providerId: "credential",
    password: input.passwordHash,
  });
  return created;
}
