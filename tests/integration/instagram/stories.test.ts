// US1/US2: an image or video Story publishes through the real scheduler, with no caption and no description.
// Mocked Graph only; the DB clock is pinned with `atTime`, never slept.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { postTargets } from "../../../src/server/db/schema/posts";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { PAGE_TOKEN } from "../../helpers/facebook-publish";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
import { IG_ID, instagramVideoSetup } from "../../helpers/instagram-publish";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { tickConfig } from "../../helpers/tick";

let graph: FakeGraph;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  graph = createFakeGraph().install();
  storage = createMemoryStorage();
  setStorageForTests(storage);
});
afterEach(() => graph.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const media = `/v26.0/${IG_ID}/media`;
const quota = `/v26.0/${IG_ID}/content_publishing_limit`;
const publish = `/v26.0/${IG_ID}/media_publish`;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick(tickConfig({}))).publishing.counts);

const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === media);
const publishes = () => graph.requests.filter((r) => r.path === publish);
const quotaOk: GraphReply = { kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } };
const inProgress: GraphReply = { kind: "ok", body: { status_code: "IN_PROGRESS" } };
const finished: GraphReply = { kind: "ok", body: { status_code: "FINISHED" } };

function script(statuses: GraphReply | GraphReply[], containerId = "s1") {
  let n = 0;
  graph.on("POST", media, () => ({ kind: "ok", body: { id: `s${++n}` } }));
  graph.on("GET", `/v26.0/${containerId}`, statuses);
  graph.on("GET", quota, quotaOk);
  graph.on("POST", publish, { kind: "ok", body: { id: "ig_story_1" } });
}

describe("an image Story through the real scheduler", () => {
  it("creates with media_type=STORIES and image_url, no caption, polls, checks quota, publishes", async () => {
    script([finished]);
    const { row } = await instagramVideoSetup(storage, "hello world", ["image"], { postType: "story" });
    expect(await tickAt(0)).toMatchObject({ claimed: 1, continued: 1 });
    expect(creates()[0]!.params.media_type).toBe("STORIES");
    expect(creates()[0]!.params.image_url).toBeTruthy();
    expect(creates()[0]!.params).not.toHaveProperty("caption");
    expect(creates()[0]!.params).not.toHaveProperty("alt_text");
    expect((await row()).nextAttemptAt!.getTime() - T0).toBe(10_000);
    expect(await tickAt(10)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
    expect(await tickAt(11)).toMatchObject({ claimed: 1, continued: 1 }); // quota
    expect(await tickAt(12)).toMatchObject({ claimed: 1, done: 1 });
    expect(publishes()).toHaveLength(1);
    expect((await row())).toMatchObject({ status: "published", externalId: "ig_story_1" });
  });

  it("ERROR fails naming the Story's media, with no token leaked", async () => {
    script({ kind: "ok", body: { status_code: "ERROR", status: `Error: bad shape ${PAGE_TOKEN}` } });
    const { row } = await instagramVideoSetup(storage, "x", ["image"], { postType: "story" });
    await tickAt(0);
    expect(await tickAt(10)).toMatchObject({ claimed: 1, failed: 1 });
    const r = await row();
    expect(r.lastError).toContain("Instagram could not process the Story's media");
    expect(r.lastError).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(r)).not.toContain(PAGE_TOKEN);
    expect(publishes()).toHaveLength(0);
  });
});

describe("a video Story through the real scheduler", () => {
  it("creates with media_type=STORIES and video_url, resumes polling, then publishes", async () => {
    script([inProgress]);
    const { row } = await instagramVideoSetup(storage, "x", ["video"], { postType: "story" });
    expect(await tickAt(0)).toMatchObject({ claimed: 1, continued: 1 });
    expect(creates()[0]!.params.media_type).toBe("STORIES");
    expect(creates()[0]!.params.video_url).toBeTruthy();
    expect((await row()).nextAttemptAt!.getTime() - T0).toBe(60_000);
    // a later tick resumes polling the same container without recreating it
    expect(await tickAt(61)).toMatchObject({ claimed: 1, continued: 1 });
    expect(creates()).toHaveLength(1);
    graph.on("GET", "/v26.0/s1", finished);
    graph.on("GET", quota, quotaOk);
    expect(await tickAt(122)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
    expect(await tickAt(123)).toMatchObject({ claimed: 1, continued: 1 }); // quota
    expect(await tickAt(124)).toMatchObject({ claimed: 1, done: 1 });
    expect(creates()).toHaveLength(1);
    expect(publishes()).toHaveLength(1);
    expect((await row())).toMatchObject({ status: "published", externalId: "ig_story_1" });
  });
});

describe("Story edge cases through the real scheduler", () => {
  it("a full daily container allowance defers the create (not failed), and creates once the window clears", async () => {
    const DAY = 86_400_000;
    const base = await instagramVideoSetup(storage, "x", ["image"], { postType: "story" });
    await testDb().insert(allowanceUses).values([{ projectId: base.projectId, socialAccountId: base.accountId, units: 400, createdAt: new Date(T0 - 3600 * 1000) }]);
    graph.on("POST", media, () => ({ kind: "ok", body: { id: "s1" } }));
    graph.on("GET", "/v26.0/s1", finished);
    graph.on("GET", quota, quotaOk);
    graph.on("POST", publish, { kind: "ok", body: { id: "ig_story_1" } });
    expect(await tickAt(0)).toMatchObject({ claimed: 1, deferred: 1 });
    expect(creates()).toHaveLength(0);
    expect((await base.row())).toMatchObject({ status: "scheduled" });
    const resumeAt = -3600 + DAY / 1000 + 2;
    expect(await tickAt(resumeAt)).toMatchObject({ claimed: 1, continued: 1 });
    expect(creates()).toHaveLength(1);
    await tickAt(resumeAt + 10);
    await tickAt(resumeAt + 11);
    expect(await tickAt(resumeAt + 12)).toMatchObject({ claimed: 1, done: 1 });
    expect(publishes()).toHaveLength(1);
    expect((await base.row())).toMatchObject({ status: "published", externalId: "ig_story_1" });
  });

  it("a full platform quota retries in about an hour without a publish request", async () => {
    script([finished]);
    const base = await instagramVideoSetup(storage, "x", ["image"], { postType: "story" });
    graph.on("GET", quota, { kind: "ok", body: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } });
    await tickAt(0);
    await tickAt(10); // FINISHED
    expect(await tickAt(11)).toMatchObject({ claimed: 1, retried: 1 });
    const r = await base.row();
    const wait = r.nextAttemptAt!.getTime() - (T0 + 11_000);
    expect(wait).toBeGreaterThanOrEqual(3_600_000);
    expect(wait).toBeLessThan(3_600_000 + 60_000);
    expect(publishes()).toHaveLength(0);
  });

  it("a container reported PUBLISHED ends ambiguous and is never retried", async () => {
    script({ kind: "ok", body: { status_code: "PUBLISHED" } });
    const base = await instagramVideoSetup(storage, "x", ["image"], { postType: "story" });
    await tickAt(0);
    expect(await tickAt(10)).toMatchObject({ claimed: 1, ambiguous: 1 });
    expect((await base.row()).status).toBe("ambiguous");
    expect(publishes()).toHaveLength(0);
    expect(await tickAt(1000)).toMatchObject({ claimed: 0 });
  });

  it("EXPIRED rebuilds the container up to twice, then fails", async () => {
    let n = 0;
    graph.on("POST", media, () => ({ kind: "ok", body: { id: `s${++n}` } }));
    for (const id of ["s1", "s2", "s3"]) graph.on("GET", `/v26.0/${id}`, { kind: "ok", body: { status_code: "EXPIRED" } });
    const base = await instagramVideoSetup(storage, "x", ["image"], { postType: "story" });
    let s = 0;
    for (let round = 0; round < 2; round++) {
      await tickAt(s);
      s += 11;
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 });
      s += 1;
    }
    await tickAt(s);
    s += 11;
    expect(await tickAt(s)).toMatchObject({ claimed: 1, failed: 1 });
    expect(creates()).toHaveLength(3);
    expect((await base.row()).lastError).toContain("tried 3 times");
    expect(publishes()).toHaveLength(0);
  });

  it("a create_container killed mid-flight is retried: one retry unit of allowance and exactly one publish", async () => {
    script([inProgress, finished]);
    const base = await instagramVideoSetup(storage, "killed", ["image"], { postType: "story" });
    const past = new Date(T0 - 60_000);
    await testDb()
      .update(postTargets)
      .set({ status: "publishing", leaseOwner: randomUUID(), leaseUntil: past, inFlightStep: "create_container", inFlightMayPublish: false, firstStepAt: past })
      .where(and(eq(postTargets.projectId, base.projectId), eq(postTargets.id, base.targetId)));
    expect(await tickAt(0)).toMatchObject({ recovered: 1, ambiguous: 0 });
    for (let s = 11; s <= 200 && (await base.row()).status !== "published"; s += 11) await tickAt(s);
    expect(await base.row()).toMatchObject({ status: "published", externalId: "ig_story_1" });
    expect(creates()).toHaveLength(1);
    expect(publishes()).toHaveLength(1);
    const units = (await testDb().select().from(allowanceUses).where(eq(allowanceUses.projectId, base.projectId))).map((u) => u.units);
    expect(units).toEqual([1]);
  });
});

describe("a mixed post: one Instagram Story target and one Facebook Page target", () => {
  it("both schedule; Facebook publishes with the text, the Story without it", async () => {
    const ctx = await createProjectWithMembers();
    const projectId = ctx.project.id;
    const ig = await forSchedulerProject(projectId).accounts.upsertConnected({
      providerKey: "instagram",
      displayName: "Docket Page · Instagram",
      externalAccountId: IG_ID,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    await forSchedulerProject(projectId).accounts.setCredentials(ig.id, encryptCredentials(ig.id, { pageToken: PAGE_TOKEN }), null);
    const fbId = "17800000000000001";
    const fb = await forSchedulerProject(projectId).accounts.upsertConnected({
      providerKey: "facebook",
      displayName: "Docket Page",
      externalAccountId: fbId,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    await forSchedulerProject(projectId).accounts.setCredentials(fb.id, encryptCredentials(fb.id, { pageToken: PAGE_TOKEN }), null);

    const repos = createSchedulingRepos(testDb(), projectId);
    const { post, targets } = await repos.posts
      .insert({ baseText: "shared caption" })
      .then(async (p) => ({ post: p, targets: await repos.targets.insertMany([{ postId: p.id, socialAccountId: ig.id }, { postId: p.id, socialAccountId: fb.id }]) }));

    const { jpeg } = await import("../../helpers/images");
    const body = await jpeg(400, 300);
    const key = `projects/${projectId}/media/0/original`;
    await storage.put(key, body, "image/jpeg");
    const asset = await repos.media.insert({ storageKey: key, publicUrl: storage.publicUrl(key), mimeType: "image/jpeg", byteSize: body.length, width: 400, height: 300 });
    await repos.posts.setMedia(post.id, [asset.id]);

    const dueAt = new Date(T0 - 60_000);
    const igTarget = targets.find((t) => t.socialAccountId === ig.id)!;
    const fbTarget = targets.find((t) => t.socialAccountId === fb.id)!;
    await repos.targets.update(igTarget.id, { status: "scheduled", scheduleKind: "explicit", scheduledAt: dueAt, nextAttemptAt: dueAt, chosenPostType: "story" });
    await repos.targets.update(fbTarget.id, { status: "scheduled", scheduleKind: "explicit", scheduledAt: dueAt, nextAttemptAt: dueAt });
    await repos.posts.setStatus(post.id, "scheduled");

    graph.on("POST", media, { kind: "ok", body: { id: "s1" } });
    graph.on("GET", "/v26.0/s1", finished);
    graph.on("GET", quota, quotaOk);
    graph.on("POST", publish, { kind: "ok", body: { id: "ig_story_mixed" } });
    graph.on("POST", `/v26.0/${fbId}/photos`, { kind: "ok", body: { id: "fb_photo_1", post_id: `${fbId}_fb_post_1` } });

    const row = async (id: string) => (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, id))))[0]!;

    expect(await tickAt(0)).toMatchObject({ claimed: 2 });
    expect(creates()[0]!.params).not.toHaveProperty("caption");
    const fbPhotoReq = graph.requests.find((r) => r.path === `/v26.0/${fbId}/photos`);
    expect(fbPhotoReq?.params.caption ?? fbPhotoReq?.params.message).toBeTruthy();

    expect(await tickAt(10)).toMatchObject({ continued: 1 }); // story finished poll
    expect(await tickAt(11)).toMatchObject({ continued: 1 }); // story quota

    expect(await tickAt(12)).toMatchObject({ done: 1 }); // story publish; facebook already done at tick 0
    expect(await row(igTarget.id)).toMatchObject({ status: "published", externalId: "ig_story_mixed" });
    expect(await row(fbTarget.id)).toMatchObject({ status: "published" });
  });
});
