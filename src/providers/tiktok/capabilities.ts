import type { CustomCountingRule, ProviderCapabilities, PublishLimit } from "../types";

export const TIKTOK_TEXT_RULE: CustomCountingRule = { kind: "custom", name: "utf16", unit: "UTF-16 units", count: (s) => s.length };

// Plan P18 (spec D8). The image planner and video formatter work from these limits alone (FR-008).
export const tiktokCapabilities: ProviderCapabilities = {
  text: { maxLength: 2200, countingRule: TIKTOK_TEXT_RULE },
  media: {
    maxImages: 35,
    allowedMimeTypes: ["image/jpeg", "image/webp"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: 20_000_000,
    maxWidth: 1080,
    maxHeight: 1920,
    required: true,
  },
  video: {
    maxVideos: 1,
    withImages: false,
    containers: ["mp4", "mov"],
    videoCodecs: ["h264", "hevc", "vp8", "vp9"],
    maxBytes: 4_000_000_000,
    maxDurationSeconds: 300,
    minWidth: 360,
    maxWidth: 4096,
    minHeight: 360,
    maxHeight: 4096,
    minFrameRate: 23,
    maxFrameRate: 60,
  },
  textOnlyAllowed: false,
  postTypes: ["image", "carousel", "video"],
};

export const TIKTOK_DEFAULT_PUBLISH_LIMIT: PublishLimit = { count: 15, windowSeconds: 86_400 };
