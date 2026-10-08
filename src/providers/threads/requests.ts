import { scrub } from "../meta/errors";
import type { MediaItem } from "../types";

/** The fields read from a container to learn how processing went. */
export const STATUS_FIELDS = "status,error_message";

/** One video as the whole post: no `alt_text`, and `text` only when there is some. */
export function videoContainerParams(item: Pick<MediaItem, "url">, text: string): Record<string, string> {
  return { media_type: "VIDEO", video_url: item.url, ...(text.length > 0 ? { text } : {}) };
}

/** A carousel item. An image keeps its alt text when not blank; a video never sends text or alt text. */
export function itemParams(kind: "image" | "video", item: Pick<MediaItem, "url" | "altText">): Record<string, string> {
  if (kind === "video") return { media_type: "VIDEO", video_url: item.url, is_carousel_item: "true" };
  return {
    media_type: "IMAGE",
    image_url: item.url,
    is_carousel_item: "true",
    ...(item.altText.trim().length > 0 ? { alt_text: item.altText } : {}),
  };
}

/** A single image container: its text rides along, as before. */
export function imageContainerParams(item: Pick<MediaItem, "url" | "altText">, text: string): Record<string, string> {
  return {
    media_type: "IMAGE",
    image_url: item.url,
    ...(text.length > 0 ? { text } : {}),
    ...(item.altText.trim().length > 0 ? { alt_text: item.altText } : {}),
  };
}

export function textContainerParams(text: string): Record<string, string> {
  return { media_type: "TEXT", text };
}

export function carouselParams(children: readonly string[], text: string): Record<string, string> {
  return { media_type: "CAROUSEL", children: children.join(","), ...(text.length > 0 ? { text } : {}) };
}

export const publishParams = (creationId: string): Record<string, string> => ({ creation_id: creationId });

/** The status code (null when absent or not a string) and the error text with any secret removed. */
export function readStatus(body: unknown, secrets: readonly string[]): { status: string | null; errorMessage: string } {
  const b = body && typeof body === "object" ? (body as { status?: unknown; error_message?: unknown }) : null;
  return {
    status: typeof b?.status === "string" ? b.status : null,
    errorMessage: typeof b?.error_message === "string" ? scrub(b.error_message, secrets).trim() : "",
  };
}
