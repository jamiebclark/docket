import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { S3StorageConfig, Storage } from "../../src/server/storage/types";

export const TEST_S3_CONFIG: S3StorageConfig = {
  bucket: "docket-test",
  accessKeyId: "AKIATESTKEY",
  secretAccessKey: "test-secret-value-do-not-leak",
  publicBaseUrl: "https://media.example.test",
  region: "auto",
  forcePathStyle: false,
  checksums: "when_required",
  previewUrls: "public",
};

export interface MemoryStorage extends Storage {
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
  /** Keys whose next `put` should fail (for failure-isolation tests). */
  failPutFor: Set<string>;
  /** Multipart uploads in flight, by upload id. */
  readonly multiparts: Map<string, MemoryMultipart>;
  /** Part numbers whose next `uploadPart` should fail, as `"<key>#<n>"` (for resume tests). */
  failPartFor: Set<string>;
  /** Number of `head` calls, so tests can assert idempotent completion resolved through it. */
  headCalls: number;
  /** Multipart methods (contracts/uploads.md "Storage interface additions"). */
  createMultipart(key: string, contentType: string): Promise<{ uploadId: string }>;
  signPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<void>;
  listParts(key: string, uploadId: string): Promise<{ partNumber: number; etag: string; bytes: number }[] | null>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<{ bytes: number } | null>;
  getToFile(key: string, path: string, signal: AbortSignal): Promise<{ bytes: number } | null>;
  putFile(key: string, path: string, contentType: string, signal: AbortSignal): Promise<{ bytes: number }>;
}

export interface MemoryMultipart {
  key: string;
  contentType: string;
  parts: Map<number, Buffer>;
}

/** An in-memory `Storage` double. `publicUrl` matches the S3 implementation's shape. */
export function createMemoryStorage(publicBaseUrl = "https://media.example.test"): MemoryStorage {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const failPutFor = new Set<string>();
  const failPartFor = new Set<string>();
  const multiparts = new Map<string, MemoryMultipart>();
  let nextUpload = 0;
  const etagOf = (b: Buffer) => `"${createHash("md5").update(b).digest("hex")}"`;
  const store: MemoryStorage = {
    objects,
    failPutFor,
    failPartFor,
    multiparts,
    headCalls: 0,
    async put(key, body, contentType) {
      if (failPutFor.has(key)) throw new Error(`injected put failure for ${key}`);
      objects.set(key, { body: Buffer.from(body), contentType });
      return { key, contentType, bytes: body.byteLength };
    },
    async delete(key) {
      objects.delete(key);
    },
    publicUrl: (key) => `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`,
    async signedUrl(key, seconds) {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) throw new RangeError("expiry out of range");
      return `${publicBaseUrl}/${key}?X-Amz-Expires=${seconds}`;
    },
    async get(key) {
      const o = objects.get(key);
      return o ? Buffer.from(o.body) : null;
    },
    async exists(key) {
      return objects.has(key);
    },
    async createMultipart(key, contentType) {
      const uploadId = `mem-upload-${++nextUpload}`;
      multiparts.set(uploadId, { key, contentType, parts: new Map() });
      return { uploadId };
    },
    async signPart(key, _uploadId, partNumber, seconds) {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) throw new RangeError("expiry out of range");
      return `memory://${key}?part=${partNumber}`;
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const up = multiparts.get(uploadId);
      if (!up || up.key !== key) throw new Error("NoSuchUpload");
      if (failPartFor.has(`${key}#${partNumber}`)) throw new Error(`injected part failure for ${key}#${partNumber}`);
      up.parts.set(partNumber, Buffer.from(body));
    },
    async listParts(key, uploadId) {
      const up = multiparts.get(uploadId);
      if (!up || up.key !== key) return null;
      return [...up.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([partNumber, b]) => ({ partNumber, etag: etagOf(b), bytes: b.length }));
    },
    async completeMultipart(key, uploadId, parts) {
      const up = multiparts.get(uploadId);
      if (!up || up.key !== key) throw new Error("NoSuchUpload");
      const chunks: Buffer[] = [];
      let last = 0;
      for (const p of parts) {
        const b = up.parts.get(p.partNumber);
        if (p.partNumber <= last || !b || etagOf(b) !== p.etag) throw new Error("InvalidPart");
        last = p.partNumber;
        chunks.push(b);
      }
      objects.set(key, { body: Buffer.concat(chunks), contentType: up.contentType });
      multiparts.delete(uploadId);
    },
    async abortMultipart(_key, uploadId) {
      multiparts.delete(uploadId);
    },
    async head(key) {
      store.headCalls++;
      const o = objects.get(key);
      return o ? { bytes: o.body.length } : null;
    },
    async getToFile(key, path, signal) {
      signal.throwIfAborted();
      const o = objects.get(key);
      if (!o) return null;
      await writeFile(path, o.body);
      return { bytes: o.body.length };
    },
    async putFile(key, path, contentType, signal) {
      signal.throwIfAborted();
      if (failPutFor.has(key)) throw new Error(`injected put failure for ${key}`);
      const body = await readFile(path);
      objects.set(key, { body, contentType });
      return { bytes: body.length };
    },
  };
  return store;
}

export interface RecordedRequest {
  method: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface MemoryS3Handler {
  /** Pass as `createS3Storage(config, { requestHandler })`. */
  handle(request: unknown): Promise<{ response: unknown }>;
  destroy(): void;
  updateHttpClientConfig(): void;
  httpHandlerConfigs(): Record<string, never>;
  readonly requests: RecordedRequest[];
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
  /** Respond to the next `times` requests (default 1) with this status and an empty body. The SDK retries 5xx. */
  failNextWith(status: number, times?: number): void;
}

async function readBody(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

/**
 * An S3 `requestHandler` that records every request and serves PUT/GET/HEAD/DELETE from memory.
 * Path style (`/bucket/key`) and virtual-hosted style (`bucket.host/key`) both resolve.
 */
export function createMemoryS3Handler(bucket = TEST_S3_CONFIG.bucket): MemoryS3Handler {
  const requests: RecordedRequest[] = [];
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  let forced: { status: number; left: number } | undefined;

  const respond = (statusCode: number, headers: Record<string, string> = {}, body?: Buffer) => ({
    response: {
      statusCode,
      reason: "",
      headers,
      body: Readable.from(body ? [body] : []),
    },
  });

  return {
    requests,
    objects,
    failNextWith(status, times = 1) {
      forced = { status, left: times };
    },
    async handle(raw) {
      const req = raw as {
        method: string;
        hostname: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      };
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const body = await readBody(req.body);
      requests.push({ method: req.method, hostname: req.hostname, path: req.path, headers, body });
      if (forced !== undefined) {
        const { status } = forced;
        if (--forced.left <= 0) forced = undefined;
        return respond(status);
      }
      const path = decodeURIComponent(req.path);
      const key = path.startsWith(`/${bucket}/`) ? path.slice(bucket.length + 2) : path.replace(/^\//, "");
      switch (req.method) {
        case "PUT":
          objects.set(key, { body, contentType: headers["content-type"] ?? "" });
          return respond(200, { etag: '"etag"' });
        case "DELETE":
          objects.delete(key);
          return respond(204);
        case "HEAD": {
          const o = objects.get(key);
          return o
            ? respond(200, { "content-type": o.contentType, "content-length": String(o.body.length) })
            : respond(404);
        }
        case "GET": {
          const o = objects.get(key);
          return o
            ? respond(200, { "content-type": o.contentType, "content-length": String(o.body.length) }, o.body)
            : respond(404, { "content-type": "application/xml" }, Buffer.from("<Error><Code>NoSuchKey</Code></Error>"));
        }
        default:
          return respond(405);
      }
    },
    destroy() {},
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
  };
}
