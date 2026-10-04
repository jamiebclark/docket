import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import { connectAttempts, projects } from "../db/schema";

export type ConnectAttemptRow = typeof connectAttempts.$inferSelect;

export interface ConnectBinding {
  userId: string;
  sessionId: string;
  now: Date;
}

/** Connect-attempt queries pinned to one project (`project_id = projectId`). */
export interface ConnectAttemptsRepo {
  create(input: {
    userId: string;
    sessionId: string;
    groupKey: string;
    stateHash: string;
    expiresAt: Date;
  }): Promise<{ id: string }>;
  /**
   * Inserts an already-called-back attempt (a token paste). `encrypt` gets the new id (the AAD needs it)
   * and returns the ciphertext. Run inside a transaction so a failed encrypt leaves no row.
   */
  createReady(input: {
    userId: string;
    sessionId: string;
    groupKey: string;
    stateHash: string;
    expiresAt: Date;
    encrypt(id: string): string;
  }): Promise<{ id: string }>;
  /** Single use: of two parallel callbacks exactly one gets `true`. */
  consumeState(id: string, binding: ConnectBinding): Promise<boolean>;
  storeCandidates(id: string, ciphertext: string): Promise<boolean>;
  getReady(id: string, binding: ConnectBinding): Promise<ConnectAttemptRow | null>;
  /** As `getReady`, locking the row; call inside a transaction. */
  getReadyForUpdate(id: string, binding: ConnectBinding): Promise<ConnectAttemptRow | null>;
  complete(id: string, now: Date): Promise<void>;
}

export function createConnectAttemptsRepo(db: Database, projectId: string): ConnectAttemptsRepo {
  const here = eq(connectAttempts.projectId, projectId);
  const bound = (id: string, b: ConnectBinding) =>
    and(
      here,
      eq(connectAttempts.id, id),
      eq(connectAttempts.userId, b.userId),
      eq(connectAttempts.sessionId, b.sessionId),
      sql`${connectAttempts.expiresAt} > ${b.now}`,
    );
  const readyWhere = (id: string, b: ConnectBinding) =>
    and(
      bound(id, b),
      isNotNull(connectAttempts.callbackAt),
      isNull(connectAttempts.completedAt),
      isNotNull(connectAttempts.candidatesEncrypted),
    );
  return {
    async create(input) {
      const [row] = await db
        .insert(connectAttempts)
        .values({ projectId, ...input })
        .returning({ id: connectAttempts.id });
      if (!row) throw new Error("Connect attempt insert returned no row");
      return row;
    },
    async createReady({ encrypt, ...input }) {
      const run = async (exec: Database) => {
        const [row] = await exec
          .insert(connectAttempts)
          .values({ projectId, ...input, callbackAt: sql`now()` })
          .returning({ id: connectAttempts.id });
        if (!row) throw new Error("Connect attempt insert returned no row");
        await exec
          .update(connectAttempts)
          .set({ candidatesEncrypted: encrypt(row.id) })
          .where(and(here, eq(connectAttempts.id, row.id)));
        return row;
      };
      return db.transaction((tx) => run(tx as unknown as Database));
    },
    async consumeState(id, b) {
      const rows = await db
        .update(connectAttempts)
        .set({ callbackAt: b.now })
        .where(and(bound(id, b), isNull(connectAttempts.callbackAt)))
        .returning({ id: connectAttempts.id });
      return rows.length === 1;
    },
    async storeCandidates(id, ciphertext) {
      const rows = await db
        .update(connectAttempts)
        .set({ candidatesEncrypted: ciphertext })
        .where(
          and(here, eq(connectAttempts.id, id), isNotNull(connectAttempts.callbackAt), isNull(connectAttempts.completedAt)),
        )
        .returning({ id: connectAttempts.id });
      return rows.length === 1;
    },
    async getReady(id, b) {
      const [row] = await db.select().from(connectAttempts).where(readyWhere(id, b)).limit(1);
      return row ?? null;
    },
    async getReadyForUpdate(id, b) {
      const [row] = await db.select().from(connectAttempts).where(readyWhere(id, b)).limit(1).for("update");
      return row ?? null;
    },
    async complete(id, now) {
      await db
        .update(connectAttempts)
        .set({ completedAt: now, candidatesEncrypted: null })
        .where(and(here, eq(connectAttempts.id, id)));
    },
  };
}

export interface ConnectStateLookup {
  id: string;
  projectId: string;
  projectSlug: string;
  userId: string;
  sessionId: string;
  groupKey: string;
}

/** Resolves an attempt from the callback's state hash. Cross-project: the state is all the callback has. */
export function lookupByStateHash(stateHash: string, db: Database = getDb()): Promise<ConnectStateLookup | null> {
  return runCrossProject("resolve connect state", async () => {
    const [row] = await db
      .select({
        id: connectAttempts.id,
        projectId: connectAttempts.projectId,
        projectSlug: projects.slug,
        userId: connectAttempts.userId,
        sessionId: connectAttempts.sessionId,
        groupKey: connectAttempts.groupKey,
      })
      .from(connectAttempts)
      .innerJoin(projects, eq(projects.id, connectAttempts.projectId))
      .where(eq(connectAttempts.stateHash, stateHash))
      .limit(1);
    return row ?? null;
  });
}

/** Deletes attempts that expired over an hour ago, in every project. Returns the count. */
export function purgeExpiredConnectAttempts(now: Date, db: Database = getDb()): Promise<number> {
  return runCrossProject("purge expired connect attempts", async () => {
    const rows = await db
      .delete(connectAttempts)
      .where(lt(connectAttempts.expiresAt, new Date(now.getTime() - 60 * 60 * 1000)))
      .returning({ id: connectAttempts.id });
    return rows.length;
  });
}
