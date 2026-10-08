import type { MediaItem } from "../types";

export const RUPLOAD_HOST = "rupload.facebook.com";

/** `POST /{page}/videos` params for a Page video. The token is added by `graphRequest`. */
export function pageVideoParams(item: Pick<MediaItem, "url">, text: string): Record<string, string> {
  return { file_url: item.url, ...(text.length > 0 ? { description: text } : {}) };
}

export function reelStartParams(): Record<string, string> {
  return { upload_phase: "start" };
}

export function reelFinishParams(videoId: string, text: string): Record<string, string> {
  return {
    upload_phase: "finish",
    video_id: videoId,
    video_state: "PUBLISHED",
    ...(text.length > 0 ? { description: text } : {}),
  };
}

/** The Authorization header is added by `ruploadRequest`, never here. */
export function ruploadHeaders(fileUrl: string): Record<string, string> {
  return { file_url: fileUrl };
}

/** Params for the status read, `GET /{videoId}`. */
export function reelStatusParams(): Record<string, string> {
  return { fields: "status" };
}

/**
 * The saved upload address, or null unless it is exactly `https://<host>/video-upload/<videoId>`
 * (optionally with a `v<n>.<n>` segment): no port, user info, query or fragment (research P7).
 */
export function checkUploadUrl(raw: unknown, videoId: string, host: string = RUPLOAD_HOST): URL | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== host || url.port !== "") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (raw.includes("?") || raw.includes("#") || raw.includes("@")) return null;
  const m = /^\/video-upload\/(?:v\d+\.\d+\/)?(\d{1,40})$/.exec(url.pathname);
  if (!m || m[1] !== videoId) return null;
  return url;
}

export interface ReelStatus {
  videoStatus: string | null;
  uploading: string | null;
  processing: string | null;
  publishing: string | null;
  publishStatus: string | null;
  /** First error message of any phase, control characters removed, at most 300 characters. The caller scrubs the token. */
  detail: string | null;
}

const lower = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.toLowerCase() : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function firstErrorMessage(phases: (Record<string, unknown> | null)[]): string | null {
  for (const phase of phases) {
    const errors = phase?.errors;
    if (!Array.isArray(errors)) continue;
    for (const e of errors) {
      const message = obj(e)?.message;
      if (typeof message === "string") {
        const clean = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
        if (clean.length > 0) return clean;
      }
    }
  }
  return null;
}

/** Conservative: an unexpected shape reads as all null, which classifies as "pending" (research P9). */
export function readReelStatus(body: unknown): ReelStatus {
  const status = obj(obj(body)?.status);
  const uploading = obj(status?.uploading_phase);
  const processing = obj(status?.processing_phase);
  const publishing = obj(status?.publishing_phase);
  return {
    videoStatus: lower(status?.video_status),
    uploading: lower(uploading?.status),
    processing: lower(processing?.status),
    publishing: lower(publishing?.status),
    publishStatus: lower(publishing?.publish_status),
    detail: firstErrorMessage([uploading, processing, publishing, status]),
  };
}

const FAILED_VIDEO_STATUSES = new Set(["error", "expired", "upload_failed"]);
const UPLOADED_VIDEO_STATUSES = new Set(["upload_complete", "processing", "ready"]);

/** Unknown values are never "complete" or "failed". */
export function uploadState(r: ReelStatus): "complete" | "failed" | "pending" {
  if (r.uploading === "error" || (r.videoStatus !== null && FAILED_VIDEO_STATUSES.has(r.videoStatus))) return "failed";
  if (r.uploading === "complete" || (r.videoStatus !== null && UPLOADED_VIDEO_STATUSES.has(r.videoStatus))) return "complete";
  return "pending";
}

/** `ready` alone is not "published": it also needs the publishing phase to say so. */
export function publishState(r: ReelStatus): "published" | "failed" | "pending" {
  if (r.processing === "error" || r.publishing === "error" || (r.videoStatus !== null && FAILED_VIDEO_STATUSES.has(r.videoStatus))) return "failed";
  if (r.videoStatus === "ready" && (r.publishing === "complete" || r.publishStatus === "published")) return "published";
  return "pending";
}
