import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMemoryS3Handler, TEST_S3_CONFIG } from "../../../tests/helpers/storage";
import { StorageError } from "./errors";
import { mediaKeys, uploadStagingKey } from "./index";
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

interface Seen {
  method: string;
  hostname: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Buffer;
}

/** A stub S3 request handler that answers the multipart commands with canned XML, by method and query. */
function multipartStub(answer: (r: Seen) => { status?: number; xml?: string; headers?: Record<string, string> }) {
  const seen: Seen[] = [];
  const handler = {
    async handle(raw: unknown) {
      const req = raw as { method: string; hostname: string; path: string; query?: Record<string, unknown>; headers: Record<string, string>; body?: unknown };
      const chunks: Buffer[] = [];
      if (req.body instanceof Readable) for await (const c of req.body) chunks.push(Buffer.from(c));
      else if (req.body) chunks.push(Buffer.from(req.body as Uint8Array));
      const r: Seen = {
        method: req.method,
        hostname: req.hostname,
        path: req.path,
        query: Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)])),
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
        body: Buffer.concat(chunks),
      };
      seen.push(r);
      const a = answer(r);
      return {
        response: {
          statusCode: a.status ?? 200,
          reason: "",
          headers: { "content-type": "application/xml", ...(a.headers ?? {}) },
          body: Readable.from(a.xml ? [Buffer.from(a.xml)] : []),
        },
      };
    },
    destroy() {},
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
  };
  return { handler, seen };
}

const noSuchUpload = { status: 404, xml: "<Error><Code>NoSuchUpload</Code><Message>gone</Message></Error>" };

describe("createS3Storage: multipart", () => {
  it("creates a multipart upload with content type and cache control, and no ACL", async () => {
    const { handler, seen } = multipartStub(() => ({
      xml: "<InitiateMultipartUploadResult><UploadId>UP1</UploadId></InitiateMultipartUploadResult>",
    }));
    const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: handler });
    expect(await storage.createMultipart("k/source", "video/mp4")).toEqual({ uploadId: "UP1" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.query).toHaveProperty("uploads");
    expect(seen[0]!.headers["content-type"]).toBe("video/mp4");
    expect(seen[0]!.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(Object.keys(seen[0]!.headers).filter((n) => n.startsWith("x-amz-acl"))).toEqual([]);
  });

  it("listParts follows NextPartNumberMarker until the list is no longer truncated", async () => {
    const { handler, seen } = multipartStub((r) => {
      if (r.query["part-number-marker"] === "2") {
        return {
          xml: "<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>3</PartNumber><ETag>\"c\"</ETag><Size>7</Size></Part></ListPartsResult>",
        };
      }
      return {
        xml: "<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>\"a\"</ETag><Size>10</Size></Part><Part><PartNumber>2</PartNumber><ETag>\"b\"</ETag><Size>10</Size></Part></ListPartsResult>",
      };
    });
    const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: handler });
    const parts = await storage.listParts("k/source", "UP1");
    expect(parts).toEqual([
      { partNumber: 1, etag: '"a"', bytes: 10 },
      { partNumber: 2, etag: '"b"', bytes: 10 },
      { partNumber: 3, etag: '"c"', bytes: 7 },
    ]);
    expect(seen).toHaveLength(2);
  });

  it("maps NoSuchUpload to null on listParts and to success on abort", async () => {
    const { handler } = multipartStub(() => noSuchUpload);
    const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: handler });
    expect(await storage.listParts("k", "UP1")).toBeNull();
    await expect(storage.abortMultipart("k", "UP1")).resolves.toBeUndefined();
  });

  it("completes with the given parts in order", async () => {
    const { handler, seen } = multipartStub(() => ({
      xml: "<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>",
    }));
    const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: handler });
    await storage.completeMultipart("k", "UP1", [
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ]);
    const body = seen[0]!.body.toString();
    expect(seen[0]!.query.uploadId).toBe("UP1");
    expect(body.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(body.indexOf("<PartNumber>2</PartNumber>"));
  });

  it("heads an object for its size, and null when missing", async () => {
    const { handler } = multipartStub((r) => (r.path.endsWith("/here") ? { headers: { "content-length": "42" } } : { status: 404 }));
    const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: handler });
    expect(await storage.head("here")).toEqual({ bytes: 42 });
    expect(await storage.head("gone")).toBeNull();
  });

  it("wraps multipart failures in StorageError without detail", async () => {
    const { handler } = multipartStub(() => ({ status: 403, xml: "<Error><Code>AccessDenied</Code></Error>" }));
    const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: handler });
    const err = await storage.uploadPart("k", "UP1", 1, Buffer.from("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as Error).message).toBe("Storage uploadPart failed (HTTP 403)");
  });

  it("putFile uploads in parts, completes, and aborts when a part fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docket-s3-"));
    try {
      const file = join(dir, "f.bin");
      writeFileSync(file, Buffer.alloc(10, 1));
      const ok = multipartStub((r) => {
        if (r.method === "POST" && "uploads" in r.query) {
          return { xml: "<InitiateMultipartUploadResult><UploadId>UP2</UploadId></InitiateMultipartUploadResult>" };
        }
        if (r.method === "PUT") return { headers: { etag: '"p1"' } };
        return { xml: "<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>" };
      });
      const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: ok.handler });
      expect(await storage.putFile("k", file, "video/mp4", new AbortController().signal)).toEqual({ bytes: 10 });
      expect(ok.seen.map((r) => r.method)).toEqual(["POST", "PUT", "POST"]);
      expect(ok.seen[1]!.body.length).toBe(10);

      const bad = multipartStub((r) => {
        if (r.method === "POST" && "uploads" in r.query) {
          return { xml: "<InitiateMultipartUploadResult><UploadId>UP3</UploadId></InitiateMultipartUploadResult>" };
        }
        if (r.method === "PUT") return { status: 403, xml: "<Error><Code>AccessDenied</Code></Error>" };
        return {};
      });
      const failing = createS3Storage(TEST_S3_CONFIG, { requestHandler: bad.handler });
      await expect(failing.putFile("k", file, "video/mp4", new AbortController().signal)).rejects.toBeInstanceOf(StorageError);
      expect(bad.seen.at(-1)!.method).toBe("DELETE");
      expect(bad.seen.at(-1)!.query.uploadId).toBe("UP3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getToFile streams to disk and returns null for a missing object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docket-s3-"));
    try {
      const { handler } = multipartStub((r) =>
        r.path.endsWith("/here")
          ? { xml: "hello", headers: { "content-type": "video/mp4", "content-length": "5" } }
          : { status: 404, xml: "<Error><Code>NoSuchKey</Code></Error>" },
      );
      const storage = createS3Storage(TEST_S3_CONFIG, { requestHandler: handler });
      const out = join(dir, "o.bin");
      expect(await storage.getToFile("here", out, new AbortController().signal)).toEqual({ bytes: 5 });
      expect(readFileSync(out, "utf8")).toBe("hello");
      expect(await storage.getToFile("gone", out, new AbortController().signal)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createS3Storage: signPart", () => {
  const sign = (cfg: Partial<typeof TEST_S3_CONFIG>) =>
    createS3Storage({ ...TEST_S3_CONFIG, ...cfg }).signPart("projects/p/uploads/u/source", "UP1", 3, 3600);

  it("signs for the browser endpoint, with no checksum parameters, even when S3_CHECKSUMS is when_supported", async () => {
    const url = new URL(
      await sign({ endpoint: "http://minio:9000", browserEndpoint: "http://localhost:9000", forcePathStyle: true, checksums: "when_supported" }),
    );
    expect(url.origin).toBe("http://localhost:9000");
    expect(url.pathname).toBe(`/${TEST_S3_CONFIG.bucket}/projects/p/uploads/u/source`);
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("uploadId")).toBe("UP1");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect([...url.searchParams.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).not.toMatch(/checksum/i);
  });

  it("falls back to the endpoint, then to the SDK default host", async () => {
    expect(new URL(await sign({ endpoint: "https://acct.r2.cloudflarestorage.com" })).hostname).toBe(
      `${TEST_S3_CONFIG.bucket}.acct.r2.cloudflarestorage.com`,
    );
    expect(new URL(await sign({})).hostname).toContain("amazonaws.com");
  });

  it("refuses an expiry out of range", async () => {
    const storage = createS3Storage(TEST_S3_CONFIG);
    await expect(storage.signPart("k", "UP1", 1, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(storage.signPart("k", "UP1", 1, 604801)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("mediaKeys: video", () => {
  it("builds the staging, original and poster keys under the project prefix", () => {
    expect(uploadStagingKey("proj", "up")).toBe("projects/proj/uploads/up/source");
    const k = mediaKeys("proj", "asset");
    expect(k.video("mp4")).toBe("projects/proj/media/asset/original.mp4");
    expect(k.video("mov")).toBe("projects/proj/media/asset/original.mov");
    expect(k.thumbnail).toBe("projects/proj/media/asset/thumb.webp");
  });
});
