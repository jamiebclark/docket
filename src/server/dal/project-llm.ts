import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { projectLlmSettings } from "../db/schema";
import type { LlmProviderName } from "../llm/types";
import { now } from "./clock";
import { crossProject } from "./scope";

export interface ProjectLlmRow {
  projectId: string;
  provider: LlmProviderName | null;
  model: string | null;
  /** Ciphertext. Never returned to a service that is not resolution. */
  apiKeyEncrypted: string | null;
  updatedAt: Date;
  updatedByUserId: string | null;
  lastCheckAt: Date | null;
  checkLeaseUntil: Date | null;
}

/** For the surface: everything except the ciphertext, plus whether one is stored. */
export interface ProjectLlmStatusRow {
  provider: LlmProviderName | null;
  model: string | null;
  hasKey: boolean;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface ProjectLlmRepo {
  /** Resolution's read. The ciphertext is in the result; nothing else calls this. */
  read(): Promise<ProjectLlmRow | null>;
  /** The surface's read. Cannot return a ciphertext. */
  status(): Promise<ProjectLlmStatusRow | null>;
  /** Set or replace. `keyCiphertext: null` keeps the stored ciphertext (FR-015, K8). */
  save(patch: {
    provider: LlmProviderName;
    model: string;
    keyCiphertext: string | null;
    updatedByUserId: string | null;
  }): Promise<ProjectLlmStatusRow>;
  /** Nulls provider, model and the ciphertext; keeps the row (FR-017, L2). */
  clear(updatedByUserId: string | null): Promise<void>;
  /** The check gate (L22). `false` means refused: in flight, or inside the cooldown. */
  claimCheck(now: Date, leaseMs: number, cooldownMs: number): Promise<boolean>;
  releaseCheck(now: Date): Promise<void>;
}

const statusColumns = {
  provider: projectLlmSettings.provider,
  model: projectLlmSettings.model,
  hasKey: sql<boolean>`${projectLlmSettings.apiKeyEncrypted} IS NOT NULL`,
  updatedAt: projectLlmSettings.updatedAt,
  updatedByUserId: projectLlmSettings.updatedByUserId,
};

/** Resolution's own repo: `src/server/llm/resolve.ts` is outside the DAL, so it reaches the default database here. */
export function projectLlmRepoFor(projectId: string): ProjectLlmRepo {
  return createProjectLlmRepo(getDb(), projectId);
}

export function createProjectLlmRepo(exec: Database, projectId: string): ProjectLlmRepo {
  const mine = eq(projectLlmSettings.projectId, projectId);
  return {
    async read() {
      const rows = await exec.select().from(projectLlmSettings).where(mine).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        projectId: row.projectId,
        provider: row.provider as LlmProviderName | null,
        model: row.model,
        apiKeyEncrypted: row.apiKeyEncrypted,
        updatedAt: row.updatedAt,
        updatedByUserId: row.updatedByUserId,
        lastCheckAt: row.lastCheckAt,
        checkLeaseUntil: row.checkLeaseUntil,
      };
    },
    async status() {
      const rows = await exec.select(statusColumns).from(projectLlmSettings).where(mine).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        provider: row.provider as LlmProviderName | null,
        model: row.model,
        hasKey: row.hasKey,
        updatedAt: row.updatedAt,
        updatedByUserId: row.updatedByUserId,
      };
    },
    async save(patch) {
      const at = await now(exec);
      if (patch.keyCiphertext === null) {
        // Keep the already-stored ciphertext (caller only passes null when a row with one exists):
        // a plain UPDATE that never mentions the column, not an upsert whose SET self-references it.
        // Postgres's ON CONFLICT DO UPDATE validates this table's multi-column CHECK constraint
        // against the proposed (excluded) row even when SET resolves the column to the old value, so
        // an insert with a null key and a self-referencing SET fails the constraint it would not
        // actually violate.
        const rows = await exec
          .update(projectLlmSettings)
          .set({
            provider: patch.provider,
            model: patch.model,
            updatedAt: at,
            updatedByUserId: patch.updatedByUserId,
          })
          .where(mine)
          .returning(statusColumns);
        const row = rows[0];
        if (row) {
          return {
            provider: row.provider as LlmProviderName | null,
            model: row.model,
            hasKey: row.hasKey,
            updatedAt: row.updatedAt,
            updatedByUserId: row.updatedByUserId,
          };
        }
      }
      const rows = await exec
        .insert(projectLlmSettings)
        .values({
          projectId,
          provider: patch.provider,
          model: patch.model,
          apiKeyEncrypted: patch.keyCiphertext,
          updatedAt: at,
          updatedByUserId: patch.updatedByUserId,
        })
        .onConflictDoUpdate({
          target: projectLlmSettings.projectId,
          set: {
            provider: patch.provider,
            model: patch.model,
            apiKeyEncrypted: patch.keyCiphertext,
            updatedAt: at,
            updatedByUserId: patch.updatedByUserId,
          },
        })
        .returning(statusColumns);
      const row = rows[0]!;
      return {
        provider: row.provider as LlmProviderName | null,
        model: row.model,
        hasKey: row.hasKey,
        updatedAt: row.updatedAt,
        updatedByUserId: row.updatedByUserId,
      };
    },
    async clear(updatedByUserId) {
      const at = await now(exec);
      await exec
        .insert(projectLlmSettings)
        .values({ projectId, provider: null, model: null, apiKeyEncrypted: null, updatedAt: at, updatedByUserId })
        .onConflictDoUpdate({
          target: projectLlmSettings.projectId,
          set: { provider: null, model: null, apiKeyEncrypted: null, updatedAt: at, updatedByUserId },
        });
    },
    async claimCheck(claimNow, leaseMs, cooldownMs) {
      const leaseUntil = new Date(claimNow.getTime() + leaseMs);
      const cooldownBefore = new Date(claimNow.getTime() - cooldownMs);
      const rows = await exec
        .insert(projectLlmSettings)
        .values({ projectId, checkLeaseUntil: leaseUntil })
        .onConflictDoUpdate({
          target: projectLlmSettings.projectId,
          set: { checkLeaseUntil: leaseUntil },
          setWhere: and(
            or(sql`${projectLlmSettings.checkLeaseUntil} IS NULL`, lte(projectLlmSettings.checkLeaseUntil, claimNow)),
            or(sql`${projectLlmSettings.lastCheckAt} IS NULL`, lte(projectLlmSettings.lastCheckAt, cooldownBefore)),
          ),
        })
        .returning({ projectId: projectLlmSettings.projectId });
      return rows.length === 1;
    },
    async releaseCheck(releaseNow) {
      await exec
        .insert(projectLlmSettings)
        .values({ projectId, lastCheckAt: releaseNow, checkLeaseUntil: null })
        .onConflictDoUpdate({
          target: projectLlmSettings.projectId,
          set: { lastCheckAt: releaseNow, checkLeaseUntil: null },
        });
    },
  };
}

/** Once per tick, for the runner's gate (L27). Cross-project by design. */
export async function anyProjectHasCredential(exec?: Database): Promise<boolean> {
  return crossProject("llm: any project has credential", async () => {
    const rows = await (exec ?? getDb())
      .select({ projectId: projectLlmSettings.projectId })
      .from(projectLlmSettings)
      .where(isNotNull(projectLlmSettings.provider))
      .limit(1);
    return rows.length > 0;
  });
}
