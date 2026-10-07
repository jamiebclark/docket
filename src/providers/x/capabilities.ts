import type { ProviderCapabilities, PublishLimit } from "../types";
import { xCountingRule } from "./text";

export const X_MAX_TEXT = 280;
export const X_MAX_IMAGES = 4;
export const X_MAX_BYTES_PER_FILE = 5_000_000;

// Research D9. No dimension limits: none is in the research.
export const xCapabilities: ProviderCapabilities = {
  text: { maxLength: X_MAX_TEXT, countingRule: xCountingRule },
  media: {
    maxImages: X_MAX_IMAGES,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: X_MAX_BYTES_PER_FILE,
    maxAltTextLength: 1000,
    required: false,
  },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel"],
};

export const X_DEFAULT_PUBLISH_LIMIT: PublishLimit = { count: 100, windowSeconds: 900 };
