import { randomUUID } from "node:crypto";
import { eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crossProject } from "../../../src/server/dal/scope";
import { getDb } from "../../../src/server/db/client";
import { mediaAssets } from "../../../src/server/db/schema";
import { setStorageForTests, mediaKeys } from "../../../src/server/storage";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { deleteMedia } from "../../../src/server/services/media";
import { processNext } from "../../../src/server/video/loop";
import { closeDb } from "../../helpers/db";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { createVideoFixtures, type VideoFixtures } from "../../helpers/video-fixtures";
import { readFileSync } from "node:fs";

const signal = new AbortController().signal;

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setStorageForTests(undefined));

let storage: MemoryStorage;
let project: { id: string };
let scope: Awaited<ReturnType<typeof postsEnv>>["scope"];

beforeEach(async () => {
  markWorkerProcess();
  // The claim is cross-project: retire anything an earlier file left queued in this worker's database.
  await crossProject("test: retire queued rows", async () =>
    await getDb().update(mediaAssets).set({ deletedAt: new Date() }).where(isNull(mediaAssets.deletedAt)),
  );
  storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  project = env.project;
  scope = env.scope;
});

/** A queued video row with `bytes` staged as its source object. */
async function queued(bytes: Buffer | null, patch: Partial<typeof mediaAssets.$inferInsert> = {}) {
  const id = randomUUID();
  const keys = mediaKeys(project.id, id);
  const source = `projects/${project.id}/uploads/${randomUUID()}/source`;
  if (bytes) storage.objects.set(source, { body: bytes, contentType: "application/octet-stream" });
  await crossProject("test: insert queued video", async () => await getDb().insert(mediaAssets).values({
    id,
    projectId: project.id,
    kind: "video",
    processingState: "processing",
    processingStep: "queued",
    storageKey: keys.video("mp4"),
    publicUrl: storage.publicUrl(keys.video("mp4")),
    mimeType: "video/mp4",
    byteSize: bytes?.length ?? 1,
    sourceStorageKey: source,
    ...patch,
  }));
  return { id, source, keys };
}
const rowOf = async (id: string) =>
  (await crossProject("test: read row", async () => await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, id))))[0]!;

describe("deleting a queued video", () => {
  it("removes the staged source object too", async () => {
    const a = await queued(Buffer.from("not a real video"));
    await deleteMedia(scope, a.id);
    expect(storage.objects.has(a.source)).toBe(false);
  });
});

describe("processNext without ffmpeg", () => {
  it("returns false when nothing is queued", async () => {
    expect(await processNext({ signal })).toBe(false);
  });

  it("fails a file that is not a video and removes the bytes", async () => {
    const a = await queued(Buffer.from("not a video at all, just text"));
    expect(await processNext({ signal })).toBe(true);
    expect(await rowOf(a.id)).toMatchObject({
      processingState: "failed",
      processingStep: null,
      processingError: "This is not an MP4 or MOV video.",
      sourceStorageKey: null,
      processingLeaseToken: null,
      processingAttempts: 1,
    });
    expect(storage.objects.has(a.source)).toBe(false);
    expect(storage.objects.has(a.keys.video("mp4"))).toBe(false);
  });

  it("fails a row whose source object is gone", async () => {
    const a = await queued(null);
    await processNext({ signal });
    expect(await rowOf(a.id)).toMatchObject({ processingState: "failed", processingError: "Docket could not process this video." });
  });

  it("lets two concurrent claims take different rows", async () => {
    const [a, b] = [await queued(Buffer.from("aaaa")), await queued(Buffer.from("bbbb"))];
    expect(await Promise.all([processNext({ signal }), processNext({ signal })])).toEqual([true, true]);
    for (const x of [a, b]) expect(await rowOf(x.id)).toMatchObject({ processingState: "failed", processingAttempts: 1 });
  });

  it("re-claims an expired lease and counts the attempt", async () => {
    const a = await queued(Buffer.from("zzzz"), {
      processingStep: "poster",
      processingAttempts: 1,
      processingLeaseToken: randomUUID(),
      processingLeaseUntil: new Date(Date.now() - 60_000),
    });
    await processNext({ signal });
    expect(await rowOf(a.id)).toMatchObject({ processingState: "failed", processingAttempts: 2 });
  });

  it("leaves a live lease alone", async () => {
    await queued(Buffer.from("zzzz"), { processingLeaseToken: randomUUID(), processingLeaseUntil: new Date(Date.now() + 60_000) });
    expect(await processNext({ signal })).toBe(false);
  });

  it("fails the item at the fourth claim", async () => {
    const a = await queued(Buffer.from("zzzz"), { processingAttempts: 3 });
    await processNext({ signal });
    expect(await rowOf(a.id)).toMatchObject({
      processingState: "failed",
      processingError: "Docket could not process this video after 3 attempts.",
      sourceStorageKey: null,
    });
    expect(storage.objects.has(a.source)).toBe(false);
  });

  it("releases on shutdown with the attempt refunded", async () => {
    const a = await queued(Buffer.from("zzzz"));
    await processNext({ signal: AbortSignal.abort() });
    expect(await rowOf(a.id)).toMatchObject({
      processingState: "processing",
      processingStep: "queued",
      processingAttempts: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
    });
    expect(storage.objects.has(a.source)).toBe(true);
  });

  it("never claims a deleted row", async () => {
    await queued(Buffer.from("zzzz"), { deletedAt: new Date() });
    expect(await processNext({ signal })).toBe(false);
  });
});

requireFfmpeg()("processNext with ffmpeg", () => {
  let fx: VideoFixtures;
  beforeAll(() => {
    fx = createVideoFixtures();
  });
  afterAll(() => fx?.cleanup());

  it("takes a clip from queued to ready with objects at the final keys and the source deleted", async () => {
    const a = await queued(readFileSync(fx.landscape));
    await processNext({ signal });
    const row = await rowOf(a.id);
    expect(row).toMatchObject({
      processingState: "ready", processingStep: null, sourceStorageKey: null, kind: "video", container: "mp4",
      width: 320, height: 180, videoCodec: "h264", audioCodec: "aac", mimeType: "video/mp4",
      thumbnailStorageKey: a.keys.thumbnail,
    });
    expect(row.durationMs).toBeGreaterThan(1900);
    expect(storage.objects.get(a.keys.video("mp4"))?.contentType).toBe("video/mp4");
    expect(storage.objects.has(a.keys.thumbnail)).toBe(true);
    expect(storage.objects.has(a.source)).toBe(false);
  });

  it("leaves no objects when the row is deleted mid-run", async () => {
    const a = await queued(readFileSync(fx.landscape));
    const putFile = storage.putFile.bind(storage);
    storage.putFile = async (...args) => {
      await crossProject("test: delete mid-run", async () =>
        await getDb().update(mediaAssets).set({ deletedAt: sql`now()` }).where(eq(mediaAssets.id, a.id)),
      );
      return putFile(...args);
    };
    await processNext({ signal });
    expect(storage.objects.has(a.keys.video("mp4"))).toBe(false);
    expect(storage.objects.has(a.keys.thumbnail)).toBe(false);
    expect(storage.objects.has(a.source)).toBe(false);
  });
});
