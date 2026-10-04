import { randomUUID } from "node:crypto";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { eq } from "drizzle-orm";
import { member, organization, projects, session, user } from "../../src/server/db/schema";
import type { Role } from "../../src/server/auth/access";
import { createVoiceProfilesRepo, createVoiceVersionsRepo, type VoiceProfileRecord } from "../../src/server/dal/voice";
import { setDefaultVoiceProfile } from "../../src/server/dal/projects";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import type { PostRecord } from "../../src/server/dal/posts";
import type { TargetRecord } from "../../src/server/dal/targets";
import { EMPTY_VOICE_CONTENT, type VoiceContent } from "../../src/lib/validation/voice";
import type { GenerationMetadata } from "../../src/lib/validation/generation";
import { createMockAccount } from "./scheduling";

// Factories write straight through the test client, so they run as deliberate cross-project work.
const unique = () => randomUUID().replace(/-/g, "").slice(0, 12);

export async function createUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const n = unique();
  return runCrossProject("test factory", async () => {
    const [row] = await getDb()
      .insert(user)
      .values({ name: `User ${n}`, email: `user-${n}@example.test`, ...overrides })
      .returning();
    return row!;
  });
}

export async function createSession(userId: string) {
  return runCrossProject("test factory", async () => {
    const [row] = await getDb()
      .insert(session)
      .values({ userId, token: `tok-${unique()}${unique()}`, expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    return row!;
  });
}

export async function createProject(overrides: { name?: string; slug?: string; timezone?: string } = {}) {
  const n = unique();
  const slug = overrides.slug ?? `proj-${n}`;
  const name = overrides.name ?? `Project ${n}`;
  return runCrossProject("test factory", async () => {
    const db = getDb();
    const [org] = await db.insert(organization).values({ name, slug }).returning();
    const [project] = await db
      .insert(projects)
      .values({ id: org!.id, name, slug, timezone: overrides.timezone ?? "UTC" })
      .returning();
    return project!;
  });
}

export async function addMember(projectId: string, userId: string, role: Role = "editor") {
  return runCrossProject("test factory", async () => {
    const [row] = await getDb()
      .insert(member)
      .values({ organizationId: projectId, userId, role })
      .returning();
    return row!;
  });
}

/** A project with one user per role. */
export async function createProjectWithMembers() {
  const project = await createProject();
  const [owner, admin, editor] = await Promise.all([createUser(), createUser(), createUser()]);
  await addMember(project.id, owner.id, "owner");
  await addMember(project.id, admin.id, "admin");
  await addMember(project.id, editor.id, "editor");
  return { project, owner, admin, editor };
}

/**
 * A voice profile with versions 1..n written through the DAL. The first profile in a project becomes the default,
 * as the service does. `versions` are the contents of v1..vn (default: one empty-ish version).
 */
export async function createVoiceProfile(
  projectId: string,
  opts: { name?: string; content?: Partial<VoiceContent>; versions?: Partial<VoiceContent>[]; createdByUserId?: string | null } = {},
): Promise<VoiceProfileRecord & { versionIds: string[] }> {
  const db = getDb();
  const profiles = createVoiceProfilesRepo(db, projectId);
  const versions = createVoiceVersionsRepo(db, projectId);
  const contents = (opts.versions ?? [opts.content ?? { voiceAndTone: "Warm, plain and direct." }]).map((c) => ({
    ...EMPTY_VOICE_CONTENT,
    ...c,
  }));
  const profile = await profiles.insert({ name: opts.name ?? `Voice ${unique()}`, createdByUserId: opts.createdByUserId ?? null });
  const versionIds: string[] = [];
  for (const [i, content] of contents.entries()) {
    const v = await versions.insert({ profileId: profile.id, version: i + 1, content, authorUserId: opts.createdByUserId ?? null });
    versionIds.push(v.id);
  }
  if (contents.length > 1) await profiles.setCurrentVersion(profile.id, contents.length);
  const existingDefault = await runCrossProject("test factory", async () => {
    const [row] = await getDb().select({ d: projects.defaultVoiceProfileId }).from(projects).where(eq(projects.id, projectId));
    return row?.d ?? null;
  });
  if (!existingDefault) await setDefaultVoiceProfile(projectId, profile.id, db);
  return { ...(await profiles.get(profile.id))!, versionIds };
}

/** A valid generation record for fixtures; override any part. */
export function generationRecordFixture(
  over: Partial<GenerationMetadata["records"][number]> & { accountIds?: string[] } = {},
): GenerationMetadata["records"][number] {
  const { accountIds = [randomUUID()], ...rest } = over;
  return {
    at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    mode: "single",
    provider: "openai",
    model: "fake-model",
    voiceProfile: { id: randomUUID(), versionId: randomUUID(), version: 1, name: "Brand" },
    inputs: { brief: "A product launch", sourceText: null, instructions: null, mediaAssetIds: [], targetAccountIds: accountIds, series: null },
    prompt: { system: "system", user: "user", images: [] },
    policies: {
      requested: { approval: null, scheduling: null },
      resolved: { approval: "review_required", scheduling: "leave_as_draft" },
      decision: { reviewState: "needs_review", queued: false, reason: "Review required" },
    },
    attempts: [{ kind: "ok", latencyMs: 5, usage: { inputTokens: 100, outputTokens: 50 } }],
    retried: null,
    output: { variants: {}, imageAltTexts: null },
    remainingProblems: [],
    ...rest,
  };
}

/**
 * A generated post waiting in the review queue: `needs_review`, a remembered scheduling policy, a valid
 * generation record, and one target per account with `override_text` set (the platform variant).
 */
export async function createPostInReview(
  projectId: string,
  opts: {
    accountIds?: readonly string[];
    baseText?: string;
    variants?: Record<string, string>;
    schedulingPolicy?: "leave_as_draft" | "add_to_queue";
    record?: Partial<GenerationMetadata["records"][number]>;
    seriesId?: string;
    seriesPosition?: number;
  } = {},
): Promise<{ post: PostRecord; targets: TargetRecord[]; accountIds: string[] }> {
  const r = forSchedulerProject(projectId);
  const accountIds = [...(opts.accountIds ?? [(await createMockAccount(projectId)).id])];
  const baseText = opts.baseText ?? "A generated post";
  const record = generationRecordFixture({ accountIds, ...opts.record });
  const post = await r.posts.insert({
    baseText,
    origin: "generated",
    reviewState: "needs_review",
    schedulingPolicy: opts.schedulingPolicy ?? "leave_as_draft",
    generationMetadata: { v: 1, records: [record] },
    ...(opts.seriesId ? { seriesId: opts.seriesId, seriesPosition: opts.seriesPosition ?? 0 } : {}),
  });
  await r.posts.setStatus(post.id, "needs_review");
  const targets = await r.targets.insertMany(
    accountIds.map((socialAccountId) => ({
      postId: post.id,
      socialAccountId,
      overrideText: opts.variants?.[socialAccountId] ?? baseText,
    })),
  );
  return { post: (await r.posts.get(post.id))!, targets, accountIds };
}
