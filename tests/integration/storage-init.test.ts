import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ensureBucket, publicReadPolicy } from "../../scripts/storage-init.mjs";

function bucketHandler() {
  const buckets = new Map<string, string | undefined>();
  const log: string[] = [];
  const respond = (statusCode: number, body = "") => ({
    response: { statusCode, reason: "", headers: {}, body: Readable.from(body ? [Buffer.from(body)] : []) },
  });
  return {
    buckets,
    log,
    async handle(raw: unknown) {
      const req = raw as { method: string; path: string; query?: Record<string, unknown>; body?: unknown };
      const bucket = req.path.replace(/^\//, "").split("/")[0]!;
      log.push(`${req.method} ${req.path}${req.query && "policy" in req.query ? "?policy" : ""}`);
      if (req.method === "PUT" && req.query && "policy" in req.query) {
        buckets.set(bucket, String(req.body));
        return respond(204);
      }
      if (req.method === "PUT") {
        if (buckets.has(bucket))
          return respond(409, "<Error><Code>BucketAlreadyOwnedByYou</Code></Error>");
        buckets.set(bucket, undefined);
        return respond(200);
      }
      return respond(405);
    },
    destroy() {},
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
  };
}

function clientWith(handler: ReturnType<typeof bucketHandler>) {
  return new S3Client({
    region: "us-east-1",
    endpoint: "http://minio.test:9000",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIATESTKEY", secretAccessKey: "test-secret-value-do-not-leak" },
    requestHandler: handler as never,
  });
}

describe("storage-init", () => {
  it("creates a missing bucket and applies the anonymous-read policy", async () => {
    const h = bucketHandler();
    await ensureBucket({ client: clientWith(h), bucket: "docket-media", log: () => {} });
    expect(h.buckets.get("docket-media")).toBe(publicReadPolicy("docket-media"));
  });

  it("is idempotent and never logs credentials", async () => {
    const h = bucketHandler();
    const lines: string[] = [];
    const run = () => ensureBucket({ client: clientWith(h), bucket: "docket-media", log: (l: string) => lines.push(l) });
    await run();
    await run();
    expect(h.buckets.size).toBe(1);
    expect(h.buckets.get("docket-media")).toContain("s3:GetObject");
    expect(lines.join("\n")).not.toMatch(/AKIATESTKEY|do-not-leak/);
  });
});
