import { readFileSync } from "node:fs";
import { eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mediaProcessingRepo } from "../../../src/server/dal/media-processing";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { crossProject } from "../../../src/server/dal/scope";
import { getDb } from "../../../src/server/db/client";
import { mediaAssets } from "../../../src/server/db/schema";
import { setStorageForTests } from "../../../src/server/storage";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { rescanNext } from "../../../src/server/video/rescan";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { createVideoFixtures, type VideoFixtures } from "../../helpers/video-fixtures";

const signal = new AbortController().signal;
const suite = requireFfmpeg();

let storage: MemoryStorage;
let project: { id: string };

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setStorageForTests(undefined));
beforeEach(async () => {
  markWorkerProcess();
  // The claim is cross-project: retire anything an earlier file left waiting for a rescan.
  await crossProject("test: retire rows", async () => await getDb().update(mediaAssets).set({ deletedAt: new Date() }).where(isNull(mediaAssets.deletedAt)));
  storage = createMemoryStorage();
  setStorageForTests(storage);
  project = (await postsEnv()).project;
});

const rowOf = async (id: string) => (await crossProject("test: read", async () => await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, id))))[0]!;
const repo = () => mediaProcessingRepo();
const claim = () => crossProject("test: claim rescan", () => repo().claimRescan(new Date()));

describe("claimRescan / finishRescan (no tools)", () => {
  it("claims only ready, live, version-1 videos", async () => {
    await createVideoAsset(project.id, { factsVersion: 2 });
    await createVideoAsset(project.id, { state: "failed" });
    expect(await claim()).toBeNull();
    const old = await createVideoAsset(project.id, { factsVersion: 1 });
    const row = await claim();
    expect(row?.id).toBe(old.id);
    expect(row?.processingLeaseToken).toBeTruthy();
    expect((await rowOf(old.id)).factsAttempts).toBe(1);
  });

  it("does not claim a row that is leased, and skips deleted rows", async () => {
    const a = await createVideoAsset(project.id, { factsVersion: 1 });
    expect((await claim())?.id).toBe(a.id);
    expect(await claim()).toBeNull();
    const b = await createVideoAsset(project.id, { factsVersion: 1 });
    await crossProject("test: delete", async () => await getDb().update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.id, b.id)));
    expect(await claim()).toBeNull();
  });

  it("prefers a video already used by a post", async () => {
    const unused = await createVideoAsset(project.id, { factsVersion: 1 });
    const used = await createVideoAsset(project.id, { factsVersion: 1 });
    await forSchedulerProject(project.id).media.markUsed([used.id], new Date());
    expect((await claim())?.id).toBe(used.id);
    expect((await claim())?.id).toBe(unused.id);
  });

  it("stops claiming after three attempts", async () => {
    const a = await createVideoAsset(project.id, { factsVersion: 1 });
    for (let i = 0; i < 3; i++) {
      const row = await claim();
      expect(row?.id).toBe(a.id);
      expect(await crossProject("test: release", () => repo().releaseRescan(a.id, row!.processingLeaseToken))).toBe(true);
    }
    expect(await claim()).toBeNull();
    const row = await rowOf(a.id);
    expect(row).toMatchObject({ factsAttempts: 3, factsVersion: 1, processingLeaseUntil: null });
  });

  it("finishRescan records the facts under the token and clears the lease; a stale token does nothing", async () => {
    const a = await createVideoAsset(project.id, { factsVersion: 1, videoBitrate: null, indexAtFront: null });
    const row = (await claim())!;
    const facts = { videoBitrate: 3_000_000, audioBitrate: 128_000, audioSampleRate: 48_000, audioChannels: 2, indexAtFront: false };
    expect(await crossProject("test: stale", () => repo().finishRescan(a.id, "00000000-0000-4000-8000-000000000000", facts))).toBe(false);
    expect((await rowOf(a.id)).factsVersion).toBe(1);
    expect(await crossProject("test: finish", () => repo().finishRescan(a.id, row.processingLeaseToken, facts))).toBe(true);
    expect(await rowOf(a.id)).toMatchObject({ ...facts, factsVersion: 2, processingLeaseUntil: null, processingLeaseToken: null });
    expect(await claim()).toBeNull();
  });

  it("leaves the stored object alone when there is nothing to rescan", async () => {
    expect(await rescanNext({ signal })).toBe(false);
  });

  it("gives the lease back when the stored object is missing", async () => {
    const a = await createVideoAsset(project.id, { factsVersion: 1 });
    expect(await rescanNext({ signal })).toBe(true);
    expect(await rowOf(a.id)).toMatchObject({ factsVersion: 1, factsAttempts: 1, processingLeaseUntil: null });
  });
});

suite("rescanNext (real ffmpeg)", () => {
  let fx: VideoFixtures;
  beforeAll(() => {
    fx = createVideoFixtures();
  });
  afterAll(() => fx?.cleanup());

  it("records the facts of an old video without touching its stored bytes", async () => {
    const a = await createVideoAsset(project.id, { factsVersion: 1, videoBitrate: null, audioBitrate: null, audioSampleRate: null, audioChannels: null, indexAtFront: null });
    const body = readFileSync(fx.indexAtEnd);
    storage.objects.set(a.storageKey, { body, contentType: "video/mp4" });
    expect(await rescanNext({ signal })).toBe(true);
    const row = await rowOf(a.id);
    expect(row.factsVersion).toBe(2);
    expect(row.indexAtFront).toBe(false);
    expect(row.videoBitrate).toBeGreaterThan(0);
    expect(row.audioSampleRate).toBeGreaterThan(0);
    expect(row.audioChannels).toBeGreaterThan(0);
    expect(row.processingLeaseToken).toBeNull();
    expect(storage.objects.get(a.storageKey)!.body.equals(body)).toBe(true);
    expect(await rescanNext({ signal })).toBe(false);
  });

  it("counts an unreadable file as an attempt and tries again, up to three times", async () => {
    const a = await createVideoAsset(project.id, { factsVersion: 1 });
    storage.objects.set(a.storageKey, { body: Buffer.from("not a video"), contentType: "video/mp4" });
    for (let i = 0; i < 3; i++) expect(await rescanNext({ signal })).toBe(true);
    expect(await rescanNext({ signal })).toBe(false);
    expect(await rowOf(a.id)).toMatchObject({ factsVersion: 1, factsAttempts: 3 });
  });

  it("reads the index position of a file that has it at the front", async () => {
    const a = await createVideoAsset(project.id, { factsVersion: 1, indexAtFront: null });
    storage.objects.set(a.storageKey, { body: readFileSync(fx.landscape), contentType: "video/mp4" });
    await rescanNext({ signal });
    expect((await rowOf(a.id)).indexAtFront).not.toBeNull();
  });
});
