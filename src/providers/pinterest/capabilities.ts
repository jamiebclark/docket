import type { ProviderCapabilities, PublishLimit } from "../types";

// contracts/pinterest-publishing.md §1. No width/height/aspect bounds: declaring them would make the
// media planner refuse a pin Pinterest would accept and crop (FR-014, U3).
export const pinterestCapabilities: ProviderCapabilities = {
  text: { maxLength: 800, countingRule: "code_points" },
  media: {
    maxImages: 1,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: 20_000_000,
    maxAltTextLength: 500,
    required: true,
  },
  video: { maxVideos: 0 },
  textOnlyAllowed: false,
  postTypes: ["image"],
};

export const PINTEREST_DEFAULT_PUBLISH_LIMIT: PublishLimit = { count: 100, windowSeconds: 60 };
