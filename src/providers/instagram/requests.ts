import type { MediaItem } from "../types";

/**
 * `media_type` sent on a video carousel item. Null: omitted, as Instagram's docs show `is_carousel_item` with
 * `video_url` alone (P14). One named value, so it changes in one place if a live check disagrees.
 * `VIDEO` is never produced anywhere.
 */
export const VIDEO_ITEM_MEDIA_TYPE: "REELS" | null = null;

/** Fields read on a video container or item. Images keep `status_code` alone (P16). */
export const VIDEO_STATUS_FIELDS = "status_code,status";
export const IMAGE_STATUS_FIELDS = "status_code";

/** The container of a single video: a Reel, or a Feed video when `shareToFeed` is true. */
export function reelContainerParams(item: Pick<MediaItem, "url">, text: string, shareToFeed: boolean): Record<string, string> {
  return {
    media_type: "REELS",
    video_url: item.url,
    ...(text.length > 0 ? { caption: text } : {}),
    share_to_feed: shareToFeed ? "true" : "false",
  };
}

/** A carousel item container: no alt text on a video, no caption on either. */
export function itemParams(kind: "image" | "video", item: Pick<MediaItem, "url" | "altText">): Record<string, string> {
  if (kind === "video") {
    return { video_url: item.url, is_carousel_item: "true", ...(VIDEO_ITEM_MEDIA_TYPE ? { media_type: VIDEO_ITEM_MEDIA_TYPE } : {}) };
  }
  return {
    image_url: item.url,
    is_carousel_item: "true",
    ...(item.altText.trim().length > 0 ? { alt_text: item.altText } : {}),
  };
}
