/** Client-safe media constants shared by the server, providers and upload controls. */
export const UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const MIME_LABEL: Record<string, string> = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };

export const VIDEO_UPLOAD_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;

export const VIDEO_MIME_LABEL: Record<string, string> = { "video/mp4": "MP4", "video/quicktime": "MOV" };

/** Longest displayed side Docket accepts for a video, in pixels. */
export const VIDEO_MAX_SIDE = 4096;
