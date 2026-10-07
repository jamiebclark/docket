import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MEDIA_MAX_OPEN_UPLOADS = "3";
});
vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import {
  cancelUploadAction,
  completeUploadAction,
  createUploadAction,
  listUploadedPartsAction,
  mediaProcessingStatusAction,
  signUploadPartsAction,
} from "../../../src/app/p/[projectSlug]/media/upload-actions";
import { PUT } from "../../../src/app/p/[projectSlug]/media/uploads/[uploadId]/parts/[partNumber]/route";
import { getDb } from "../../../src/server/db/client";
import { mediaUploads } from "../../../src/server/db/schema";
import { expireUploads } from "../../../src/server/scheduler/housekeeping";
import { setStorageForTests } from "../../../src/server/storage";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setStorageForTests(undefined));

const MIB = 1_048_576;

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  actAs(env.owner);
  return { storage, ...env };
}

type Env = Awaited<ReturnType<typeof setup>>;

const inProject = (env: Env, id: string) => and(eq(mediaUploads.projectId, env.project.id), eq(mediaUploads.id, id));
const rowOf = async (env: Env, id: string) =>
  (await getDb().select().from(mediaUploads).where(inProject(env, id)))[0]!;

async function create(env: Env, kind: "image" | "video", declaredType: string, bytes: number, filename = "f") {
  const res = await createUploadAction(env.project.slug, { filename, kind, declaredType, bytes });
  if (!res.ok) throw new Error(res.message);
  return res.data;
}

/** What the browser does on `direct`: PUT each part straight to the bucket (here, the memory double). */
async function sendParts(env: Env, uploadId: string, body: Buffer, only?: number[]) {
  const row = await rowOf(env, uploadId);
  const numbers = only ?? Array.from({ length: row.partCount }, (_, i) => i + 1);
  const signed = await signUploadPartsAction(env.project.slug, { uploadId, partNumbers: numbers });
  if (!signed.ok || !signed.data.ok) throw new Error("sign failed");
  for (const p of signed.data.parts) {
    expect(p.url.startsWith("memory://")).toBe(true); // SC-001: the bytes go to the bucket, not to Docket
    const start = (p.partNumber - 1) * row.partSize;
    await env.storage.uploadPart(row.storageKey, row.storageUploadId!, p.partNumber, body.subarray(start, start + row.partSize));
  }
}

const fakeVideo = (bytes: number) => Buffer.alloc(bytes, 7);

describe("upload sessions", () => {
  it("uploads an image through create, sign, parts and complete, and completes it twice idempotently", async () => {
    const env = await setup();
    const body = await png(300, 200);
    const created = await create(env, "image", "image/png", body.length, "../x/pic.png");
    expect(created).toMatchObject({ ok: true, upload: { partCount: 1, transport: "direct" } });
    if (!created.ok) return;
    await sendParts(env, created.upload.id, body);
    const done = await completeUploadAction(env.project.slug, { uploadId: created.upload.id });
    expect(done).toMatchObject({ ok: true, data: { ok: true, asset: { kind: "image", status: "ready", mimeType: "image/png", width: 300 } } });
    const again = await completeUploadAction(env.project.slug, { uploadId: created.upload.id });
    expect(again.ok && again.data.ok && again.data.asset.id).toBe(done.ok && done.data.ok && done.data.asset.id);
    expect([...env.storage.objects.keys()].some((k) => k.endsWith("/source"))).toBe(false);
  });

  it("completes a video as processing/queued with a staging source and no bytes through the app", async () => {
    const env = await setup();
    const body = fakeVideo(17 * MIB);
    const created = await create(env, "video", "video/mp4", body.length);
    if (!created.ok) throw new Error("create");
    expect(created.upload.partCount).toBe(3);
    await sendParts(env, created.upload.id, body);
    const listed = await listUploadedPartsAction(env.project.slug, { uploadId: created.upload.id });
    expect(listed).toMatchObject({ ok: true, data: { ok: true, confirmedBytes: 17 * MIB } });
    const done = await completeUploadAction(env.project.slug, { uploadId: created.upload.id });
    expect(done).toMatchObject({ ok: true, data: { ok: true, asset: { kind: "video", status: "processing", processingStep: "queued" } } });
    const status = await mediaProcessingStatusAction(env.project.slug, { ids: [done.ok && done.data.ok ? done.data.asset.id : ""] });
    expect(status).toMatchObject({ ok: true, data: { items: [{ status: "processing", step: "queued", waitingForWorker: false }] } });
  });

  it("answers parts_missing, then accepts the missing part after a retry", async () => {
    const env = await setup();
    const body = fakeVideo(17 * MIB);
    const created = await create(env, "video", "video/mp4", body.length);
    if (!created.ok) throw new Error("create");
    await sendParts(env, created.upload.id, body, [1, 2]);
    const first = await completeUploadAction(env.project.slug, { uploadId: created.upload.id });
    expect(first).toMatchObject({ ok: true, data: { ok: false, code: "parts_missing" } });
    const listed = await listUploadedPartsAction(env.project.slug, { uploadId: created.upload.id });
    expect(listed.ok && listed.data.ok && listed.data.parts.map((p) => p.partNumber)).toEqual([1, 2]);
    await sendParts(env, created.upload.id, body, [3]);
    expect(await completeUploadAction(env.project.slug, { uploadId: created.upload.id })).toMatchObject({
      data: { ok: true, asset: { status: "processing" } },
    });
  });

  it("refuses a session whose parts add up to more than was declared (size mismatch)", async () => {
    const env = await setup();
    const body = fakeVideo(3 * MIB);
    const created = await create(env, "video", "video/mp4", body.length);
    if (!created.ok) throw new Error("create");
    await sendParts(env, created.upload.id, body);
    const row = await rowOf(env, created.upload.id);
    await env.storage.uploadPart(row.storageKey, row.storageUploadId!, 2, fakeVideo(MIB));
    const res = await completeUploadAction(env.project.slug, { uploadId: created.upload.id });
    expect(res).toMatchObject({ ok: true, data: { ok: false, code: "size_mismatch" } });
    expect((await rowOf(env, created.upload.id)).state).toBe("refused");
    expect(env.storage.objects.size).toBe(0);
    expect(await signUploadPartsAction(env.project.slug, { uploadId: created.upload.id, partNumbers: [1] })).toMatchObject({
      data: { ok: false, code: "upload_finished" },
    });
  });

  it("refuses an image the server cannot read, as today", async () => {
    const env = await setup();
    const body = Buffer.alloc(2000, 1);
    const created = await create(env, "image", "image/png", body.length);
    if (!created.ok) throw new Error("create");
    await sendParts(env, created.upload.id, body);
    expect(await completeUploadAction(env.project.slug, { uploadId: created.upload.id })).toMatchObject({
      data: { ok: false, code: "unreadable" },
    });
    expect(env.storage.objects.size).toBe(0);
  });

  it("refuses at create: wrong type, too large, no storage", async () => {
    const env = await setup();
    expect(await createUploadAction(env.project.slug, { filename: "a", kind: "video", declaredType: "image/png", bytes: 10 })).toMatchObject({
      data: { ok: false, code: "unsupported_type" },
    });
    expect(await createUploadAction(env.project.slug, { filename: "a", kind: "image", declaredType: "image/png", bytes: 999 * MIB })).toMatchObject({
      data: { ok: false, code: "too_large" },
    });
    setStorageForTests(null);
    expect(await createUploadAction(env.project.slug, { filename: "a", kind: "image", declaredType: "image/png", bytes: 10 })).toMatchObject({
      data: { ok: false, code: "storage_unavailable" },
    });
  });

  it("hides another member's session and a removed member's access as not_found", async () => {
    const env = await setup();
    const created = await create(env, "image", "image/png", 100);
    if (!created.ok) throw new Error("create");
    actAs(env.editor);
    for (const call of [
      signUploadPartsAction(env.project.slug, { uploadId: created.upload.id, partNumbers: [1] }),
      listUploadedPartsAction(env.project.slug, { uploadId: created.upload.id }),
      completeUploadAction(env.project.slug, { uploadId: created.upload.id }),
      cancelUploadAction(env.project.slug, { uploadId: created.upload.id }),
    ]) {
      expect(await call).toMatchObject({ ok: false, error: "not_found" });
    }
    actAs(null);
    expect(await createUploadAction(env.project.slug, { filename: "a", kind: "image", declaredType: "image/png", bytes: 10 })).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("caps open sessions per member and frees a slot on cancel", async () => {
    const env = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await create(env, "image", "image/png", 100);
      if (c.ok) ids.push(c.upload.id);
    }
    expect(ids).toHaveLength(3);
    expect(await create(env, "image", "image/png", 100)).toMatchObject({ ok: false, code: "too_many_open" });
    expect(await cancelUploadAction(env.project.slug, { uploadId: ids[0] })).toMatchObject({ ok: true, data: { ok: true } });
    expect(await cancelUploadAction(env.project.slug, { uploadId: ids[0] })).toMatchObject({ ok: true, data: { ok: true } });
    expect((await create(env, "image", "image/png", 100)).ok).toBe(true);
    expect(env.storage.multiparts.size).toBe(3);
  });

  it("cancel aborts the multipart upload and removes the staging object; a finished session cannot be cancelled", async () => {
    const env = await setup();
    const body = await png(50, 50);
    const created = await create(env, "image", "image/png", body.length);
    if (!created.ok) throw new Error("create");
    await sendParts(env, created.upload.id, body);
    await cancelUploadAction(env.project.slug, { uploadId: created.upload.id });
    expect(env.storage.multiparts.size).toBe(0);
    const second = await create(env, "image", "image/png", body.length);
    if (!second.ok) throw new Error("create");
    await sendParts(env, second.upload.id, body);
    await completeUploadAction(env.project.slug, { uploadId: second.upload.id });
    expect(await cancelUploadAction(env.project.slug, { uploadId: second.upload.id })).toMatchObject({ data: { ok: false, code: "upload_finished" } });
  });

  it("housekeeping expires old open sessions and aborts them", async () => {
    const env = await setup();
    const created = await create(env, "image", "image/png", 100);
    if (!created.ok) throw new Error("create");
    expect(await expireUploads(new Date())).toBe(0);
    expect(await expireUploads(new Date(Date.now() + 25 * 3_600_000))).toBeGreaterThanOrEqual(1);
    expect((await rowOf(env, created.upload.id)).state).toBe("expired");
    expect(env.storage.multiparts.size).toBe(0);
  });
});

describe("chunk route (via_app)", () => {
  const put = (slug: string, uploadId: string, n: number, body: Buffer, contentLength = body.length) =>
    PUT(
      new Request("http://localhost/x", {
        method: "PUT",
        body: new Uint8Array(body),
        headers: { "content-length": String(contentLength) },
      }),
      { params: Promise.resolve({ projectSlug: slug, uploadId, partNumber: String(n) }) },
    );

  async function viaApp() {
    const env = await setup();
    const created = await create(env, "video", "video/mp4", 9 * MIB);
    if (!created.ok) throw new Error("create");
    await getDb().update(mediaUploads).set({ transport: "via_app" }).where(inProject(env, created.upload.id));
    return { env, id: created.upload.id };
  }

  it("signs app URLs, stores a correct chunk and rejects a wrong length", async () => {
    const { env, id } = await viaApp();
    const signed = await signUploadPartsAction(env.project.slug, { uploadId: id, partNumbers: [1, 2] });
    expect(signed.ok && signed.data.ok && signed.data.parts[0]!.url).toBe(`/p/${env.project.slug}/media/uploads/${id}/parts/1`);
    expect((await put(env.project.slug, id, 1, fakeVideo(8 * MIB))).status).toBe(204);
    expect((await put(env.project.slug, id, 2, fakeVideo(MIB - 1))).status).toBe(400);
    const header = await put(env.project.slug, id, 2, fakeVideo(MIB), 5);
    expect(await header.json()).toMatchObject({ error: "length_mismatch" });
    expect((await put(env.project.slug, id, 9, fakeVideo(MIB))).status).toBe(400);
    expect((await put(env.project.slug, id, 2, fakeVideo(MIB))).status).toBe(204);
    expect(await completeUploadAction(env.project.slug, { uploadId: id })).toMatchObject({ data: { ok: true } });
    expect((await put(env.project.slug, id, 1, fakeVideo(8 * MIB))).status).toBe(409);
  });

  it("answers 404 to anyone else and 502 when storage refuses", async () => {
    const { env, id } = await viaApp();
    env.storage.failPartFor.add(`projects/${env.project.id}/uploads/${id}/source#1`);
    expect((await put(env.project.slug, id, 1, fakeVideo(8 * MIB))).status).toBe(502);
    actAs(env.editor);
    expect((await put(env.project.slug, id, 1, fakeVideo(8 * MIB))).status).toBe(404);
    actAs(null);
    expect((await put(env.project.slug, id, 1, fakeVideo(8 * MIB))).status).toBe(404);
  });
});
