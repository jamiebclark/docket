import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  voiceProfileVersions,
  voiceProfiles,
  type VoiceProfileRow,
  type VoiceProfileVersionRow,
} from "../db/schema";
import { ConflictError } from "./errors";

export type VoiceProfileRecord = VoiceProfileRow;
export type VoiceVersionRecord = VoiceProfileVersionRow;

export interface VoiceProfilesRepo {
  /** Live profiles by name; `includeArchived` adds archived ones. */
  list(opts?: { includeArchived?: boolean }): Promise<VoiceProfileRecord[]>;
  get(id: string): Promise<VoiceProfileRecord | null>;
  /** Like `get`, but takes a row lock (`FOR UPDATE`); only meaningful inside a transaction. */
  getForUpdate(id: string): Promise<VoiceProfileRecord | null>;
  /** Starts at `current_version` 1; the caller inserts version 1 in the same transaction. */
  insert(input: { name: string; createdByUserId?: string | null }): Promise<VoiceProfileRecord>;
  rename(id: string, name: string): Promise<void>;
  setCurrentVersion(id: string, version: number): Promise<void>;
  setArchived(id: string, at: Date | null): Promise<void>;
}

/** Immutable history: there is deliberately no `update` and no `delete` (research D22). */
export interface VoiceVersionsRepo {
  insert(input: {
    profileId: string;
    version: number;
    content: unknown;
    authorUserId?: string | null;
  }): Promise<VoiceVersionRecord>;
  get(id: string): Promise<VoiceVersionRecord | null>;
  getByNumber(profileId: string, version: number): Promise<VoiceVersionRecord | null>;
  /** Newest first. */
  listForProfile(profileId: string): Promise<VoiceVersionRecord[]>;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e?.code ?? e?.cause?.code) === "23505";
}

export function createVoiceProfilesRepo(db: Database, projectId: string): VoiceProfilesRepo {
  const mine = (id: string) => and(eq(voiceProfiles.projectId, projectId), eq(voiceProfiles.id, id));
  const nameTaken = () => new ConflictError("A profile with this name already exists", "name");
  return {
    async list(opts) {
      const conds = [eq(voiceProfiles.projectId, projectId)];
      if (!opts?.includeArchived) conds.push(isNull(voiceProfiles.archivedAt));
      return db
        .select()
        .from(voiceProfiles)
        .where(and(...conds))
        .orderBy(asc(voiceProfiles.name), asc(voiceProfiles.id));
    },
    async get(id) {
      const [row] = await db.select().from(voiceProfiles).where(mine(id)).limit(1);
      return row ?? null;
    },
    async getForUpdate(id) {
      const [row] = await db.select().from(voiceProfiles).where(mine(id)).limit(1).for("update");
      return row ?? null;
    },
    async insert(input) {
      try {
        const [row] = await db
          .insert(voiceProfiles)
          .values({ projectId, name: input.name, createdByUserId: input.createdByUserId ?? null })
          .returning();
        return row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
    },
    async rename(id, name) {
      try {
        await db.update(voiceProfiles).set({ name }).where(mine(id));
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
    },
    async setCurrentVersion(id, version) {
      await db.update(voiceProfiles).set({ currentVersion: version }).where(mine(id));
    },
    async setArchived(id, at) {
      try {
        await db.update(voiceProfiles).set({ archivedAt: at }).where(mine(id));
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
    },
  };
}

export function createVoiceVersionsRepo(db: Database, projectId: string): VoiceVersionsRepo {
  const mine = and(eq(voiceProfileVersions.projectId, projectId));
  return {
    async insert(input) {
      const [row] = await db
        .insert(voiceProfileVersions)
        .values({
          projectId,
          profileId: input.profileId,
          version: input.version,
          content: input.content,
          authorUserId: input.authorUserId ?? null,
        })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await db
        .select()
        .from(voiceProfileVersions)
        .where(and(mine, eq(voiceProfileVersions.id, id)))
        .limit(1);
      return row ?? null;
    },
    async getByNumber(profileId, version) {
      const [row] = await db
        .select()
        .from(voiceProfileVersions)
        .where(and(mine, eq(voiceProfileVersions.profileId, profileId), eq(voiceProfileVersions.version, version)))
        .limit(1);
      return row ?? null;
    },
    async listForProfile(profileId) {
      return db
        .select()
        .from(voiceProfileVersions)
        .where(and(mine, eq(voiceProfileVersions.profileId, profileId)))
        .orderBy(desc(voiceProfileVersions.version));
    },
  };
}
