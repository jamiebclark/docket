import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { describe, expect, it } from "vitest";
import { uploadOrigin, uploadOriginFromEnv, type UploadOriginInput } from "./upload-origin";

/** The origin of the URL the real SDK presigns for an UploadPart, offline. */
async function sdkOrigin(i: UploadOriginInput): Promise<string> {
  const endpoint = i.browserEndpoint || i.endpoint;
  const client = new S3Client({
    region: i.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: i.forcePathStyle,
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const url = await getSignedUrl(
    client,
    new UploadPartCommand({ Bucket: i.bucket, Key: "projects/p/uploads/u/source", UploadId: "UP", PartNumber: 1 }),
    { expiresIn: 60 },
  );
  return new URL(url).origin;
}

const cases: [string, UploadOriginInput][] = [
  ["AWS default, virtual-hosted", { bucket: "docket-media", region: "eu-west-1", forcePathStyle: false }],
  ["AWS default, auto region", { bucket: "docket-media", region: "auto", forcePathStyle: false }],
  ["AWS default, path style", { bucket: "docket-media", region: "us-east-1", forcePathStyle: true }],
  [
    "R2 endpoint",
    { bucket: "docket-media", region: "auto", endpoint: "https://abc.r2.cloudflarestorage.com", forcePathStyle: false },
  ],
  [
    "MinIO path style",
    { bucket: "docket-media", region: "auto", endpoint: "http://minio:9000", forcePathStyle: true },
  ],
  [
    "MinIO endpoint, virtual-hosted",
    { bucket: "docket-media", region: "auto", endpoint: "http://minio:9000", forcePathStyle: false },
  ],
  [
    "endpoint that is an IP address",
    { bucket: "docket-media", region: "auto", endpoint: "http://10.0.0.5:9000", forcePathStyle: false },
  ],
  [
    "browser endpoint over an internal endpoint (path style)",
    {
      bucket: "docket-media",
      region: "auto",
      endpoint: "http://minio:9000",
      browserEndpoint: "http://localhost:9000",
      forcePathStyle: true,
    },
  ],
  [
    "browser endpoint over R2",
    {
      bucket: "docket-media",
      region: "auto",
      endpoint: "https://abc.r2.cloudflarestorage.com",
      browserEndpoint: "https://s3.example.com:8443",
      forcePathStyle: false,
    },
  ],
  [
    "bucket name with dots",
    { bucket: "docket.media.bucket", region: "us-east-1", forcePathStyle: false },
  ],
];

describe("uploadOrigin", () => {
  it.each(cases)("equals the SDK's presigned UploadPart origin: %s", async (_name, input) => {
    expect(uploadOrigin(input)).toBe(await sdkOrigin(input));
  });
});

describe("uploadOriginFromEnv", () => {
  const env = { S3_BUCKET: "docket-media", S3_ENDPOINT: "http://minio:9000", S3_FORCE_PATH_STYLE: "true" };

  it("reads the storage settings", () => {
    expect(uploadOriginFromEnv(env)).toBe("http://minio:9000");
    expect(uploadOriginFromEnv({ ...env, S3_BROWSER_ENDPOINT: "http://localhost:9000" })).toBe("http://localhost:9000");
  });

  it("is null without storage, or with the via_app transport", () => {
    expect(uploadOriginFromEnv({})).toBeNull();
    expect(uploadOriginFromEnv({ ...env, MEDIA_UPLOAD_TRANSPORT: "via_app" })).toBeNull();
  });

  it("is null rather than throwing on a malformed endpoint", () => {
    expect(uploadOriginFromEnv({ ...env, S3_ENDPOINT: "not a url" })).toBeNull();
  });
});
