// voice: versioned voice profiles and the "Try it" sandbox (contracts/services.md § Voice profiles).
import { z } from "zod";
import { findProvider } from "@/providers/registry";
import { countText, countingRuleName } from "@/providers/text";
import { BRIEF_MAX, TARGET_ACCOUNTS_MAX } from "@/lib/validation/generation";
import { voiceContentInputSchema, voiceContentSchema, voiceNameSchema, type VoiceContent } from "@/lib/validation/voice";
import { ConflictError, ForbiddenError, NotFoundError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import type { VoiceProfileRecord, VoiceVersionRecord } from "../dal/voice";
import type { LlmProvider } from "../llm/types";
import { runGeneration } from "./generation/core";
import { GROUP_LIMIT, groupTargets } from "../../lib/generation/groups";
import type { AccountRecord } from "../dal/accounts";
import { assertGroupLimit, groupsForAccounts } from "./generation/groups";
import { loadAccounts } from "./generation/single";

export interface VoiceProfileSummary {
  id: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  currentVersion: number;
  updatedAt: Date;
}

export interface VersionView {
  id: string;
  version: number;
  content: VoiceContent;
  authorName: string | null;
  createdAt: Date;
}

export interface TryItVariant {
  /** The variant group key: the platform, or `${platform}_${n}` when its accounts have different instructions. */
  key: string;
  providerKey: string;
  providerName: string;
  accountNames: string[];
  text: string;
  count: number;
  limit: number;
  countingRule: string;
  issues: string[];
}

export interface TryItResult {
  variants: TryItVariant[];
  latencyMs: number;
}

const STALE = "This profile changed since you opened it";

function need(scope: Pick<ProjectScope, "can">, request: Parameters<ProjectScope["can"]>[0]): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

const profileIdSchema = z.uuid();
const parseId = (id: unknown): string => {
  const parsed = profileIdSchema.safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
};

const createSchema = z.object({ name: voiceNameSchema, content: voiceContentInputSchema });
const saveSchema = createSchema.extend({ baseVersion: z.number().int().min(1) });

async function authorNames(scope: ProjectScope): Promise<Map<string, string>> {
  const members = await scope.members.list();
  return new Map(members.map((m) => [m.userId, m.name]));
}

function view(row: VoiceVersionRecord, names: Map<string, string>): VersionView {
  return {
    id: row.id,
    version: row.version,
    content: voiceContentSchema.parse(row.content),
    authorName: row.authorUserId ? (names.get(row.authorUserId) ?? null) : null,
    createdAt: row.createdAt,
  };
}

async function loadProfile(scope: Pick<ProjectScope, "voiceProfiles">, id: unknown, lock = false): Promise<VoiceProfileRecord> {
  const profileId = parseId(id);
  const profile = lock ? await scope.voiceProfiles.getForUpdate(profileId) : await scope.voiceProfiles.get(profileId);
  if (!profile) throw new NotFoundError();
  return profile;
}

export async function listVoiceProfiles(
  scope: ProjectScope,
  input: { includeArchived?: boolean } = {},
): Promise<VoiceProfileSummary[]> {
  need(scope, { voice: ["view"] });
  const rows = await scope.voiceProfiles.list({ includeArchived: input.includeArchived ?? false });
  const defaultId = (await scope.projects.get())?.defaultVoiceProfileId ?? scope.project.defaultVoiceProfileId;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isDefault: r.id === defaultId,
    archived: r.archivedAt !== null,
    currentVersion: r.currentVersion,
    updatedAt: r.updatedAt,
  }));
}

export async function getVoiceProfile(
  scope: ProjectScope,
  profileId: string,
): Promise<{ profile: VoiceProfileRecord; current: VersionView; isDefault: boolean }> {
  need(scope, { voice: ["view"] });
  const profile = await loadProfile(scope, profileId);
  const row = await scope.voiceVersions.getByNumber(profile.id, profile.currentVersion);
  if (!row) throw new NotFoundError();
  const defaultId = (await scope.projects.get())?.defaultVoiceProfileId ?? null;
  return { profile, current: view(row, await authorNames(scope)), isDefault: profile.id === defaultId };
}

export async function listVersions(
  scope: ProjectScope,
  profileId: string,
): Promise<{ version: number; id: string; authorName: string | null; createdAt: Date }[]> {
  need(scope, { voice: ["view"] });
  const profile = await loadProfile(scope, profileId);
  const names = await authorNames(scope);
  const rows = await scope.voiceVersions.listForProfile(profile.id);
  return rows.map((r) => ({
    version: r.version,
    id: r.id,
    authorName: r.authorUserId ? (names.get(r.authorUserId) ?? null) : null,
    createdAt: r.createdAt,
  }));
}

export async function getVersion(scope: ProjectScope, profileId: string, version: number): Promise<VersionView> {
  need(scope, { voice: ["view"] });
  const profile = await loadProfile(scope, profileId);
  const row = Number.isInteger(version) ? await scope.voiceVersions.getByNumber(profile.id, version) : null;
  if (!row) throw new NotFoundError();
  return view(row, await authorNames(scope));
}

export async function createVoiceProfile(scope: ProjectScope, input: unknown): Promise<{ profileId: string; version: 1 }> {
  need(scope, { voice: ["manage"] });
  const parsed = createSchema.parse(input);
  return scope.transaction(
    async (tx) => {
      need(tx, { voice: ["manage"] });
      const profile = await tx.voiceProfiles.insert({ name: parsed.name, createdByUserId: tx.membership.userId });
      await tx.voiceVersions.insert({
        profileId: profile.id,
        version: 1,
        content: parsed.content,
        authorUserId: tx.membership.userId,
      });
      if (!tx.project.defaultVoiceProfileId) await tx.projects.setDefaultVoiceProfile(profile.id);
      return { profileId: profile.id, version: 1 as const };
    },
    { lockProject: true },
  );
}

export async function saveVoiceProfile(
  scope: ProjectScope,
  profileId: string,
  input: unknown,
): Promise<{ version: number }> {
  need(scope, { voice: ["manage"] });
  const parsed = saveSchema.parse(input);
  return scope.transaction(async (tx) => {
    need(tx, { voice: ["manage"] });
    const profile = await loadProfile(tx, profileId, true);
    if (profile.archivedAt) throw new ConflictError("Restore this profile before editing it");
    if (profile.currentVersion !== parsed.baseVersion) throw new ConflictError(STALE);
    const current = await tx.voiceVersions.getByNumber(profile.id, profile.currentVersion);
    if (!current) throw new NotFoundError();
    if (
      profile.name === parsed.name &&
      JSON.stringify(voiceContentInputSchema.parse(current.content)) === JSON.stringify(parsed.content)
    ) {
      return { version: profile.currentVersion };
    }
    const next = profile.currentVersion + 1;
    if (profile.name !== parsed.name) await tx.voiceProfiles.rename(profile.id, parsed.name);
    await tx.voiceVersions.insert({
      profileId: profile.id,
      version: next,
      content: parsed.content,
      authorUserId: tx.membership.userId,
    });
    await tx.voiceProfiles.setCurrentVersion(profile.id, next);
    return { version: next };
  });
}

export async function setDefaultVoiceProfile(scope: ProjectScope, profileId: string): Promise<void> {
  need(scope, { voice: ["manage"] });
  await scope.transaction(
    async (tx) => {
      need(tx, { voice: ["manage"] });
      const profile = await loadProfile(tx, profileId);
      if (profile.archivedAt) throw new ConflictError("Restore this profile before making it the default");
      await tx.projects.setDefaultVoiceProfile(profile.id);
    },
    { lockProject: true },
  );
}

export async function archiveVoiceProfile(scope: ProjectScope, profileId: string): Promise<void> {
  need(scope, { voice: ["manage"] });
  await scope.transaction(
    async (tx) => {
      need(tx, { voice: ["manage"] });
      const profile = await loadProfile(tx, profileId);
      if (profile.archivedAt) return;
      if (tx.project.defaultVoiceProfileId === profile.id) {
        throw new ConflictError("Make another profile the default first");
      }
      await tx.voiceProfiles.setArchived(profile.id, new Date());
    },
    { lockProject: true },
  );
}

export async function restoreVoiceProfile(scope: ProjectScope, profileId: string): Promise<void> {
  need(scope, { voice: ["manage"] });
  await scope.transaction(
    async (tx) => {
      need(tx, { voice: ["manage"] });
      const profile = await loadProfile(tx, profileId);
      if (!profile.archivedAt) return;
      await tx.voiceProfiles.setArchived(profile.id, null);
    },
    { lockProject: true },
  );
}

export const tryVoiceSchema = z.object({
  brief: z
    .string()
    .trim()
    .min(1, { error: "Write a brief" })
    .max(BRIEF_MAX, { error: "The brief can be at most 2,000 characters" }),
  accountIds: z
    .array(z.uuid())
    .min(1, { error: "Choose at least one account" })
    .max(TARGET_ACCOUNTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Each account can be chosen once" })
    .optional(),
  draft: voiceContentInputSchema.optional(),
  versionId: z.uuid().optional(),
});

/**
 * Generates sample posts to hear a voice on chosen accounts; writes nothing (no post, no failure row, research D24).
 * Owners and admins may pass unsaved `draft` content; everyone else tries a saved `versionId`.
 */
export async function tryVoice(scope: ProjectScope, input: unknown, llm?: LlmProvider): Promise<TryItResult> {
  need(scope, { voice: ["view"] });
  need(scope, { generation: ["run"] });
  const parsed = tryVoiceSchema.parse(input);

  let content: VoiceContent;
  if (parsed.draft && scope.can({ voice: ["manage"] })) {
    content = voiceContentSchema.parse(parsed.draft);
  } else {
    if (!parsed.versionId) throw new ConflictError("Choose a saved version to try");
    const row = await scope.voiceVersions.get(parsed.versionId);
    if (!row) throw new NotFoundError();
    content = voiceContentSchema.parse(row.content);
  }

  let accounts: AccountRecord[];
  if (parsed.accountIds) {
    accounts = await loadAccounts(scope, parsed.accountIds);
  } else {
    const all = await scope.accounts.list();
    accounts = [];
    for (const account of all) {
      if (groupTargets([...accounts, account]).length > GROUP_LIMIT) continue;
      accounts.push(account);
    }
  }
  if (accounts.length === 0) throw new ConflictError("Connect an account to try the voice.");
  const groups = groupsForAccounts(accounts);
  assertGroupLimit(groups);

  const outcome = await runGeneration(
    scope,
    {
      label: "voice.try",
      voice: { content },
      groups,
      assets: [],
      inputs: { brief: parsed.brief, sourceText: null, instructions: null, series: null },
    },
    llm,
  );
  if (!outcome.ok) throw new ConflictError(outcome.message);

  const variants = groups.map((group): TryItVariant => {
    const provider = findProvider(group.providerKey)!;
    const caps = provider.capabilities.text;
    const text = outcome.output.variants[group.key] ?? "";
    return {
      key: group.key,
      providerKey: group.providerKey,
      providerName: provider.displayName,
      accountNames: group.accounts.map((a) => a.displayName),
      text,
      count: countText(text, caps.countingRule),
      limit: caps.maxLength,
      countingRule: countingRuleName(caps.countingRule),
      issues: outcome.remainingProblems.find((p) => p.groupKey === group.key)?.messages ?? [],
    };
  });
  return { variants, latencyMs: outcome.attempts.reduce((sum, a) => sum + a.latencyMs, 0) };
}

/** The project's default voice profile id, if one is set. */
export async function defaultVoiceProfileId(scope: ProjectScope): Promise<string | null> {
  need(scope, { voice: ["view"] });
  return (await scope.projects.get())?.defaultVoiceProfileId ?? scope.project.defaultVoiceProfileId ?? null;
}
