/** Client-safe media constants shared by the server, providers and upload controls. */
export const UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const MIME_LABEL: Record<string, string> = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
