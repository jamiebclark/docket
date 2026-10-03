import { describe, expect, it } from "vitest";
import { createMemoryS3Handler, TEST_S3_CONFIG } from "../../../tests/helpers/storage";
import { StorageError } from "./errors";
import { mediaKeys } from "./index";
import { createS3Storage } from "./s3";

function setup(over: Partial<typeof TEST_S3_CONFIG> = {}) {
  const handler = createMemoryS3Handler();
  const storage = createS3Storage({ ...TEST_S3_CONFIG, ...over }, { requestHandler: handler });
  return { handler, storage };
}

describe("createS3Storage", () => {
  it("puts with content type and cache control, and nothing R2 does not support (FR-040)", async () => {
    const { handler, storage } = setup();
    const res = await storage.put("projects/p/media/a/original.jpg", Buffer.from("abc"), "image/jpeg");
    expect(res).toEqual({ key: "projects/p/media/a/original.jpg", contentType: "image/jpeg", bytes: 3 });
    const put = handler.requests.find((r) => r.method === "PUT")!;
    expect(put.headers["content-type"]).toBe("image/jpeg");
    expect(put.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const names = Object.keys(put.headers);
    expect(names.filter((n) => /^x-amz-(acl|tagging|object-lock|server-side-encryption)/.test(n))).toEqual([]);
    expect(names.filter((n) => n.startsWith("x-amz-checksum-") || n === "x-amz-sdk-checksum-algorithm")).toEqual([]);
  });

  it("sets content type on every put", async () => {
    const { handler, storage } = setup();
    const k = mediaKeys("p", "a");
    await storage.put(k.original("png"), Buffer.from("1"), "image/png");
    await storage.put(k.thumbnail, Buffer.from("2"), "image/webp");
    await storage.put(k.variant("h", "jpg"), Buffer.from("3"), "image/jpeg");
    const puts = handler.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.headers["content-type"])).toEqual(["image/png", "image/webp", "image/jpeg"]);
  });

  it("requests checksums only when supported if configured so", async () => {
    const { handler, storage } = setup({ checksums: "when_supported" });
    await storage.put("k", Buffer.from("abc"), "image/png");
    const names = Object.keys(handler.requests[0]!.headers);
    expect(names.some((n) => n.startsWith("x-amz-checksum-") || n === "x-amz-sdk-checksum-algorithm")).toBe(true);
  });

  it("round-trips get and exists, mapping 404 to null / false", async () => {
    const { storage } = setup();
    expect(await storage.get("missing")).toBeNull();
    expect(await storage.exists("missing")).toBe(false);
    await storage.put("here", Buffer.from("xyz"), "image/png");
    expect((await storage.get("here"))?.toString()).toBe("xyz");
    expect(await storage.exists("here")).toBe(true);
  });

  it("deletes with the right path in both addressing styles, and deleting a missing key succeeds", async () => {
    const virtual = setup();
    await virtual.storage.put("a/b.png", Buffer.from("1"), "image/png");
    await virtual.storage.delete("a/b.png");
    const del = virtual.handler.requests.find((r) => r.method === "DELETE")!;
    expect(del.hostname).toBe(`${TEST_S3_CONFIG.bucket}.s3.auto.amazonaws.com`);
    expect(del.path).toBe("/a/b.png");
    await expect(virtual.storage.delete("a/b.png")).resolves.toBeUndefined();

    const path = setup({ forcePathStyle: true, endpoint: "http://minio:9000" });
    await path.storage.delete("a/b.png");
    const del2 = path.handler.requests.find((r) => r.method === "DELETE")!;
    expect(del2.hostname).toBe("minio");
    expect(del2.path).toBe(`/${TEST_S3_CONFIG.bucket}/a/b.png`);
  });

  it("builds public URLs by encoding each segment and stripping a trailing slash", () => {
    const { storage } = setup({ publicBaseUrl: "https://m.example.test/base/" });
    expect(storage.publicUrl("projects/p/media/a b/é.png")).toBe(
      "https://m.example.test/base/projects/p/media/a%20b/%C3%A9.png",
    );
  });

  it("signs URLs within bounds only", async () => {
    const { storage } = setup();
    expect(await storage.signedUrl("k.png", 1)).toContain("X-Amz-Expires=1");
    expect(await storage.signedUrl("k.png", 604800)).toContain("X-Amz-Expires=604800");
    await expect(storage.signedUrl("k.png", 0)).rejects.toBeInstanceOf(RangeError);
    await expect(storage.signedUrl("k.png", 604801)).rejects.toBeInstanceOf(RangeError);
  });

  it("turns SDK failures into StorageError without leaking credentials", async () => {
    const { handler, storage } = setup();
    handler.failNextWith(503, 10); // outlasts the SDK's retries
    const err = await storage.put("k", Buffer.from("1"), "image/png").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as Error).message).toBe("Storage put failed (HTTP 503)");
    expect((err as Error).message).not.toContain(TEST_S3_CONFIG.accessKeyId);
    expect((err as Error).message).not.toContain(TEST_S3_CONFIG.secretAccessKey);
  });
});

describe("mediaKeys", () => {
  it("keeps every key under the project prefix", () => {
    const k = mediaKeys("proj", "asset");
    for (const key of [k.original("jpg"), k.thumbnail, k.variant("abc", "webp")]) {
      expect(key.startsWith("projects/proj/media/asset/")).toBe(true);
    }
    expect(k.variant("abc", "webp")).toBe("projects/proj/media/asset/v/abc.webp");
  });
});
