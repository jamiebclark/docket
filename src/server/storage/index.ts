import { getEnv } from "../env";
import { StorageUnavailableError } from "./errors";
import { createS3Storage } from "./s3";
import type { Storage } from "./types";

export { StorageError, StorageUnavailableError } from "./errors";
export { createS3Storage } from "./s3";
export type { S3StorageConfig, Storage, StoredObject } from "./types";

let cached: Storage | null | undefined;

/** Memoised per process from `getEnv().storage`; `null` when the storage settings are unset. */
export function getStorage(): Storage | null {
  if (cached !== undefined) return cached;
  const config = getEnv().storage;
  cached = config ? createS3Storage(config) : null;
  return cached;
}

export function requireStorage(): Storage {
  const storage = getStorage();
  if (!storage) throw new StorageUnavailableError();
  return storage;
}

/** Test seam: replaces (or with `undefined` resets) the memoised storage. */
export function setStorageForTests(storage: Storage | null | undefined): void {
  cached = storage;
}

type Ext = "jpg" | "png" | "webp";
type VideoExt = "mp4" | "mov";

/** The only way the service layer builds object keys; every key starts with `projects/<projectId>/`. */
export function mediaKeys(projectId: string, assetId: string) {
  const base = `projects/${projectId}/media/${assetId}`;
  return {
    original: (ext: Ext) => `${base}/original.${ext}`,
    thumbnail: `${base}/thumb.webp`,
    variant: (hash: string, ext: Ext) => `${base}/v/${hash}.${ext}`,
    video: (ext: VideoExt) => `${base}/original.${ext}`,
    videoVersion: (key: string) => `${base}/vv/${key}.mp4`,
    videoPreview: (key: string) => `${base}/vp/${key}.mp4`,
  };
}

/** Staging object of one upload session: the bucket assembles the multipart upload here (contracts/uploads.md). */
export function uploadStagingKey(projectId: string, uploadId: string): string {
  return `projects/${projectId}/uploads/${uploadId}/source`;
}
