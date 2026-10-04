import { describe, expect, it } from "vitest";
import { createS3Storage } from "../../src/server/storage/s3";
import type { S3StorageConfig } from "../../src/server/storage/types";

// Opt-in: runs only against a real MinIO (or other S3-compatible) endpoint, e.g. the Compose `offline`
// profile. Set S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY_ID, S3_TEST_SECRET_ACCESS_KEY and
// optionally S3_TEST_PUBLIC_BASE_URL. Without S3_TEST_ENDPOINT the suite is reported as skipped.
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!endpoint)("storage against a real S3-compatible endpoint", () => {
  const bucket = process.env.S3_TEST_BUCKET ?? "docket-media";
  const config: S3StorageConfig = {
    bucket,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "docket-dev",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "docket-dev-password",
    publicBaseUrl: process.env.S3_TEST_PUBLIC_BASE_URL ?? `${endpoint}/${bucket}`,
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    checksums: "when_required",
    previewUrls: "public",
  };

  it("puts, serves public and signed URLs, checks existence, and deletes", async () => {
    const storage = createS3Storage(config);
    const key = `projects/test/media/${crypto.randomUUID()}/original.png`;
    const body = Buffer.from("not really a png");
    await storage.put(key, body, "image/png");
    try {
      expect(await storage.exists(key)).toBe(true);
      expect((await storage.get(key))?.equals(body)).toBe(true);

      const pub = await fetch(storage.publicUrl(key));
      expect(pub.status).toBe(200);
      expect(pub.headers.get("content-type")).toBe("image/png");

      const signed = await fetch(await storage.signedUrl(key, 60));
      expect(signed.status).toBe(200);
    } finally {
      await storage.delete(key);
    }
    expect(await storage.exists(key)).toBe(false);
  });
});
