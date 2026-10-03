import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import { invitation, invitationTokens, projects, user } from "../db/schema";

/** Token queries pinned to one project (`project_id = projectId`). */
export interface TokensRepo {
  insert(input: { invitationId: string; tokenHash: string; createdBy: string | null }): Promise<void>;
  /** Revokes every still-active token of an invitation (revoke, regenerate, decline, accept). */
  closeActive(invitationId: string): Promise<void>;
}

export function createTokensRepo(db: Database, projectId: string): TokensRepo {
  return {
    async insert(input) {
      await db.insert(invitationTokens).values({
        projectId,
        invitationId: input.invitationId,
        tokenHash: input.tokenHash,
        createdBy: input.createdBy,
      });
    },
    async closeActive(invitationId) {
      await db
        .update(invitationTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(invitationTokens.projectId, projectId),
            eq(invitationTokens.invitationId, invitationId),
            isNull(invitationTokens.usedAt),
            isNull(invitationTokens.revokedAt),
          ),
        );
    },
  };
}

export interface TokenLookup {
  invitationId: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  inviterName: string;
  tokenUsedAt: Date | null;
  tokenRevokedAt: Date | null;
}

/** Looks a token up by hash. Cross-project: the token is the only thing the caller has. */
export function lookupToken(tokenHash: string, db: Database = getDb()): Promise<TokenLookup | null> {
  return runCrossProject("resolve invitation token", async () => {
    const [row] = await db
      .select({
        invitationId: invitation.id,
        projectId: projects.id,
        projectSlug: projects.slug,
        projectName: projects.name,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        inviterName: user.name,
        tokenUsedAt: invitationTokens.usedAt,
        tokenRevokedAt: invitationTokens.revokedAt,
      })
      .from(invitationTokens)
      .innerJoin(invitation, eq(invitation.id, invitationTokens.invitationId))
      .innerJoin(projects, eq(projects.id, invitation.organizationId))
      .innerJoin(user, eq(user.id, invitation.inviterId))
      .where(eq(invitationTokens.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Claims a token with one conditional UPDATE … RETURNING (research D6): it succeeds only while
 * the token is unused and unrevoked and its invitation is pending and unexpired. Of two
 * concurrent claims exactly one gets a row back.
 */
export function claimToken(
  tokenHash: string,
  db: Database,
): Promise<{ invitationId: string; projectId: string } | null> {
  return runCrossProject("claim invitation token", async () => {
    const [row] = await db
      .update(invitationTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(invitationTokens.tokenHash, tokenHash),
          isNull(invitationTokens.usedAt),
          isNull(invitationTokens.revokedAt),
          sql`exists (select 1 from ${invitation} where ${invitation.id} = ${invitationTokens.invitationId} and ${invitation.status} = 'pending' and ${invitation.expiresAt} > now())`,
        ),
      )
      .returning({ invitationId: invitationTokens.invitationId, projectId: invitationTokens.projectId });
    return row ?? null;
  });
}
