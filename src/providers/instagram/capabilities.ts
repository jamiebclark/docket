import type { ProviderCapabilities } from "../types";

// R1 interim: Instagram captions are limited to 2,200 characters.
export const INSTAGRAM_MAX_TEXT = 2_200;
export const INSTAGRAM_MAX_IMAGES = 10;
export const INSTAGRAM_MAX_BYTES_PER_FILE = 8_000_000;

export const instagramCapabilities: ProviderCapabilities = {
  text: { maxLength: INSTAGRAM_MAX_TEXT, countingRule: "code_points" },
  media: {
    maxImages: INSTAGRAM_MAX_IMAGES,
    allowedMimeTypes: ["image/jpeg"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: INSTAGRAM_MAX_BYTES_PER_FILE,
    maxWidth: 1440,
    minAspectRatio: 0.8,
    maxAspectRatio: 1.91,
    maxAltTextLength: 1000,
    required: true,
  },
  textOnlyAllowed: false,
  postTypes: ["image", "carousel"],
};

export const INSTAGRAM_DEFAULT_PUBLISH_LIMIT = { count: 100, windowSeconds: 86_400 } as const;
