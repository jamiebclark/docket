import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3StorageConfig } from "../env";
import { StorageError } from "./errors";
import type { Storage } from "./types";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_SIGNED_SECONDS = 604800;
const PUT_FILE_PART_BYTES = 16 * 1024 * 1024;

function statusOf(err: unknown): number | undefined {
  const e = err as { $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode;
}

function isMissing(err: unknown): boolean {
  const e = err as { name?: string };
  return statusOf(err) === 404 || e?.name === "NoSuchKey" || e?.name === "NotFound";
}

function isMissingUpload(err: unknown): boolean {
  const e = err as { name?: string };
  return statusOf(err) === 404 || e?.name === "NoSuchUpload";
}

function checkExpiry(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SIGNED_SECONDS) {
    throw new RangeError(`expiresInSeconds must be an integer from 1 to ${MAX_SIGNED_SECONDS}`);
  }
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
  // Presigned part URLs are used by browsers: they need the browser-facing endpoint, and a browser cannot
  // compute `x-amz-checksum-*`, so this client never asks for checksums (research P3).
  const browserEndpoint = config.browserEndpoint ?? config.endpoint;
  const signer = new S3Client({
    region: config.region,
    ...(browserEndpoint ? { endpoint: browserEndpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
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
      checkExpiry(expiresInSeconds);
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

    async createMultipart(key, contentType) {
      try {
        const res = await client.send(
          new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, CacheControl: CACHE_CONTROL }),
        );
        if (!res.UploadId) throw new StorageError("createMultipart");
        return { uploadId: res.UploadId };
      } catch (err) {
        if (err instanceof StorageError) throw err;
        throw new StorageError("createMultipart", statusOf(err), err);
      }
    },
    async signPart(key, uploadId, partNumber, expiresInSeconds) {
      checkExpiry(expiresInSeconds);
      try {
        return await getSignedUrl(
          signer,
          new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
          { expiresIn: expiresInSeconds },
        );
      } catch (err) {
        throw new StorageError("signPart", statusOf(err), err);
      }
    },
    async uploadPart(key, uploadId, partNumber, body) {
      try {
        await client.send(
          new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }),
        );
      } catch (err) {
        throw new StorageError("uploadPart", statusOf(err), err);
      }
    },
    async listParts(key, uploadId) {
      const out: { partNumber: number; etag: string; bytes: number }[] = [];
      let marker: string | undefined;
      try {
        for (;;) {
          const res = await client.send(
            new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
          );
          for (const p of res.Parts ?? []) {
            if (p.PartNumber === undefined || !p.ETag) continue;
            out.push({ partNumber: p.PartNumber, etag: p.ETag, bytes: p.Size ?? 0 });
          }
          if (!res.IsTruncated || !res.NextPartNumberMarker) break;
          marker = res.NextPartNumberMarker;
        }
      } catch (err) {
        if (isMissingUpload(err)) return null;
        throw new StorageError("listParts", statusOf(err), err);
      }
      return out;
    },
    async completeMultipart(key, uploadId, parts) {
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
          }),
        );
      } catch (err) {
        throw new StorageError("completeMultipart", statusOf(err), err);
      }
    },
    async abortMultipart(key, uploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
      } catch (err) {
        if (isMissingUpload(err)) return;
        throw new StorageError("abortMultipart", statusOf(err), err);
      }
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { bytes: res.ContentLength ?? 0 };
      } catch (err) {
        if (isMissing(err)) return null;
        throw new StorageError("head", statusOf(err), err);
      }
    },
    async getToFile(key, path, signal) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }), { abortSignal: signal });
        if (!res.Body) return null;
        await pipeline(res.Body as Readable, createWriteStream(path), { signal });
        return { bytes: (await stat(path)).size };
      } catch (err) {
        if (isMissing(err)) return null;
        throw new StorageError("getToFile", statusOf(err), err);
      }
    },
    async putFile(key, path, contentType, signal) {
      const total = (await stat(path)).size;
      let uploadId: string | undefined;
      try {
        const created = await client.send(
          new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, CacheControl: CACHE_CONTROL }),
          { abortSignal: signal },
        );
        uploadId = created.UploadId;
        if (!uploadId) throw new StorageError("putFile");
        const parts: { PartNumber: number; ETag: string }[] = [];
        let partNumber = 0;
        for (let start = 0; start < total || partNumber === 0; start += PUT_FILE_PART_BYTES) {
          signal.throwIfAborted();
          const end = Math.min(start + PUT_FILE_PART_BYTES, total);
          const chunks: Buffer[] = [];
          if (end > start) for await (const c of createReadStream(path, { start, end: end - 1 })) chunks.push(c as Buffer);
          partNumber += 1;
          const res = await client.send(
            new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: Buffer.concat(chunks) }),
            { abortSignal: signal },
          );
          parts.push({ PartNumber: partNumber, ETag: res.ETag ?? "" });
        }
        await client.send(
          new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }),
          { abortSignal: signal },
        );
        return { bytes: total };
      } catch (err) {
        if (uploadId) {
          await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })).catch(() => {});
        }
        if (err instanceof StorageError) throw err;
        throw new StorageError("putFile", statusOf(err), err);
      }
    },
  };
}
