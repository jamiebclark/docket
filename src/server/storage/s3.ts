import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3StorageConfig } from "../env";
import { StorageError } from "./errors";
import type { Storage } from "./types";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_SIGNED_SECONDS = 604800;

function statusOf(err: unknown): number | undefined {
  const e = err as { $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode;
}

function isMissing(err: unknown): boolean {
  const e = err as { name?: string };
  return statusOf(err) === 404 || e?.name === "NoSuchKey" || e?.name === "NotFound";
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * S3-compatible storage (R2, S3, MinIO). Sends only options R2 supports: no ACL, tagging, object
 * lock or KMS headers. SDK errors are rethrown as `StorageError` so no endpoint detail leaks.
 */
export function createS3Storage(config: S3StorageConfig, opts: { requestHandler?: unknown } = {}): Storage {
  const checksum = config.checksums === "when_supported" ? "WHEN_SUPPORTED" : "WHEN_REQUIRED";
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: checksum,
    responseChecksumValidation: checksum,
    ...(opts.requestHandler ? { requestHandler: opts.requestHandler as never } : {}),
  });
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  const Bucket = config.bucket;

  return {
    async put(key, body, contentType) {
      try {
        await client.send(
          new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, CacheControl: CACHE_CONTROL }),
        );
      } catch (err) {
        throw new StorageError("put", statusOf(err), err);
      }
      return { key, contentType, bytes: body.byteLength };
    },
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (err) {
        if (isMissing(err)) return;
        throw new StorageError("delete", statusOf(err), err);
      }
    },
    publicUrl: (key) => `${base}/${encodeKey(key)}`,
    async signedUrl(key, expiresInSeconds) {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_SIGNED_SECONDS) {
        throw new RangeError(`expiresInSeconds must be an integer from 1 to ${MAX_SIGNED_SECONDS}`);
      }
      try {
        return await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: expiresInSeconds });
      } catch (err) {
        throw new StorageError("sign", statusOf(err), err);
      }
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) return null;
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (isMissing(err)) return null;
        throw new StorageError("get", statusOf(err), err);
      }
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw new StorageError("head", statusOf(err), err);
      }
    },
  };
}
