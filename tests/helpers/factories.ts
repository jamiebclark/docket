import { randomUUID } from "node:crypto";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { eq } from "drizzle-orm";
import { member, organization, projects, session, user } from "../../src/server/db/schema";
import type { Role } from "../../src/server/auth/access";
import { createVoiceProfilesRepo, createVoiceVersionsRepo, type VoiceProfileRecord } from "../../src/server/dal/voice";
import { setDefaultVoiceProfile } from "../../src/server/dal/projects";
import type { PostRecord } from "../../src/server/dal/posts";
import type { TargetRecord } from "../../src/server/dal/targets";
import { EMPTY_VOICE_CONTENT, type VoiceContent } from "../../src/lib/validation/voice";
import type { GenerationMetadata } from "../../src/lib/validation/generation";
import { createJobItemsRepo, createJobsRepo, type JobItemRecord, type JobRecord } from "../../src/server/dal/jobs";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import { createMediaAsset, createMockAccount } from "./scheduling";

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

/**
 * A generation job with items, written straight to the database (no model call, no reservation checks).
 * Defaults: a fresh voice profile (pinned version), one mock account, `review_required` + `leave_as_draft`,
 * and `items` queued items numbered from 0. Pass `itemOverrides` to set per-item fields (status, media, …).
 */
export async function createJob(
  projectId: string,
  opts: {
    items?: number;
    template?: string;
    templateFields?: string[];
    status?: JobRecord["status"];
    sourceKind?: string;
    voiceProfileId?: string;
    accountIds?: string[];
    approval?: "review_required" | "auto_approve";
    scheduling?: "leave_as_draft" | "add_to_queue";
    createdByUserId?: string | null;
    withMedia?: boolean;
    itemOverrides?: (position: number) => Partial<Parameters<ReturnType<typeof createJobItemsRepo>["insertMany"]>[1][number]>;
  } = {},
): Promise<{ job: JobRecord; items: JobItemRecord[]; accountIds: string[]; voiceProfileId: string }> {
  const db = getDb();
  const voice = opts.voiceProfileId
    ? { id: opts.voiceProfileId, versionIds: [] as string[] }
    : { id: (await createVoiceProfile(projectId)).id, versionIds: [] as string[] };
  const profile = await createVoiceProfilesRepo(db, projectId).get(voice.id);
  const version = await createVoiceVersionsRepo(db, projectId).getByNumber(voice.id, profile!.currentVersion);
  const accountIds = opts.accountIds ?? [(await createMockAccount(projectId)).id];
  const count = opts.items ?? 1;
  const jobs = createJobsRepo(db, projectId);
  const job = await jobs.insert({
    sourceKind: opts.sourceKind ?? "csv",
    sourceSummary: `${count} rows`,
    voiceProfileId: voice.id,
    voiceProfileVersionId: version!.id,
    template: opts.template ?? "Write about {{product}}",
    templateFields: opts.templateFields ?? ["product"],
    targetAccountIds: accountIds,
    approvalPolicy: opts.approval ?? "review_required",
    schedulingPolicy: opts.scheduling ?? "leave_as_draft",
    itemCount: count,
    createdByUserId: opts.createdByUserId ?? null,
  });
  const newItems = [];
  for (let position = 0; position < count; position++) {
    const mediaAssetId = opts.withMedia ? (await createMediaAsset(projectId)).id : null;
    newItems.push({
      position,
      label: `Row ${position + 1}`,
      payload: { v: 1, fields: { product: `Product ${position + 1}` } },
      mediaAssetId,
      ...opts.itemOverrides?.(position),
    });
  }
  const items = await createJobItemsRepo(db, projectId).insertMany(job.id, newItems);
  const finalJob = opts.status && opts.status !== "queued" ? (await jobs.update(job.id, statusPatch(opts.status)))! : job;
  return { job: finalJob, items, accountIds, voiceProfileId: voice.id };
}

function statusPatch(status: JobRecord["status"]) {
  const at = new Date();
  return {
    status,
    ...(status !== "queued" ? { startedAt: at } : {}),
    ...(status === "completed" || status === "completed_with_failures" ? { finishedAt: at } : {}),
    ...(status === "cancelled" ? { cancelledAt: at } : {}),
  };
}

/** Adds one item to an existing job at the next position. */
export async function createJobItem(
  projectId: string,
  jobId: string,
  position: number,
  over: Partial<Parameters<ReturnType<typeof createJobItemsRepo>["insertMany"]>[1][number]> = {},
): Promise<JobItemRecord> {
  const [item] = await createJobItemsRepo(getDb(), projectId).insertMany(jobId, [
    { position, label: `Row ${position + 1}`, payload: { v: 1, fields: { product: `Product ${position + 1}` } }, ...over },
  ]);
  return item!;
}

/** `count` image assets (an alt text on each, so no gaps), newest last. Returns the rows. */
export interface VideoAssetOptions {
  state?: "processing" | "ready" | "failed";
  durationSeconds?: number;
  frameRate?: number | null;
  videoCodec?: string;
  audioCodec?: string | null;
  container?: "mp4" | "mov";
  width?: number;
  height?: number;
  byteSize?: number;
  error?: string;
  videoBitrate?: number | null;
  audioBitrate?: number | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  indexAtFront?: boolean | null;
  factsVersion?: 1 | 2;
  factsAttempts?: number;
}

/** A video row with the given facts, no ffmpeg and no stored object: for limits, validation and gate tests. */
export async function createVideoAsset(projectId: string, o: VideoAssetOptions = {}) {
  const state = o.state ?? "ready";
  const container = o.container ?? "mp4";
  const key = `test/${unique()}.${container}`;
  const ready = state === "ready";
  const silentAudio = o.audioCodec === null;
  return forSchedulerProject(projectId).media.insert({
    storageKey: key,
    publicUrl: `http://localhost:3000/media/${key}`,
    mimeType: container === "mov" ? "video/quicktime" : "video/mp4",
    byteSize: o.byteSize ?? 5_000_000,
    kind: "video",
    processingState: state,
    processingStep: state === "processing" ? "queued" : null,
    processingError: state === "failed" ? (o.error ?? "Docket could not read this video.") : null,
    ...(ready
      ? {
          width: o.width ?? 1280,
          height: o.height ?? 720,
          durationMs: Math.round((o.durationSeconds ?? 20) * 1000),
          frameRate: o.frameRate === undefined ? 30 : o.frameRate,
          videoCodec: o.videoCodec ?? "h264",
          audioCodec: o.audioCodec === undefined ? "aac" : o.audioCodec,
          container,
          videoBitrate: o.videoBitrate === undefined ? 2_000_000 : o.videoBitrate,
          audioBitrate: silentAudio ? null : o.audioBitrate === undefined ? 128_000 : o.audioBitrate,
          audioSampleRate: silentAudio ? null : o.audioSampleRate === undefined ? 44_100 : o.audioSampleRate,
          audioChannels: silentAudio ? null : o.audioChannels === undefined ? 2 : o.audioChannels,
          indexAtFront: o.indexAtFront === undefined ? true : o.indexAtFront,
          factsVersion: o.factsVersion ?? 2,
          factsAttempts: o.factsAttempts ?? 0,
        }
      : {}),
  });
}

export async function createImageAssets(projectId: string, count: number, opts: { altText?: string } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await createMediaAsset(projectId, { altText: opts.altText ?? `Image ${i + 1}` }));
  return out;
}

/** CSV bytes from a header and rows; values are quoted when they need it. `eol` defaults to "\n". */
export function csvBuilder(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
  opts: { eol?: string; bom?: boolean } = {},
): Buffer {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const text = [columns, ...rows].map((r) => r.map(cell).join(",")).join(opts.eol ?? "\n") + (opts.eol ?? "\n");
  return Buffer.from((opts.bom ? "\uFEFF" : "") + text, "utf8");
}
