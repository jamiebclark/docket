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
}

/** An in-memory `Storage` double. `publicUrl` matches the S3 implementation's shape. */
export function createMemoryStorage(publicBaseUrl = "https://media.example.test"): MemoryStorage {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const failPutFor = new Set<string>();
  return {
    objects,
    failPutFor,
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
  };
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
