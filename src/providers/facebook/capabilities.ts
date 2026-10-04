import type { ProviderCapabilities } from "../types";

// R1 interim: Meta publishes no hard Page post length; this is the long-standing 10,000 limit.
export const FACEBOOK_MAX_TEXT = 10_000;
// R2 interim: photo count and size limits are not published as hard numbers.
export const FACEBOOK_MAX_IMAGES = 10;
export const FACEBOOK_MAX_BYTES_PER_FILE = 8_000_000;

export const facebookCapabilities: ProviderCapabilities = {
  text: { maxLength: FACEBOOK_MAX_TEXT, countingRule: "code_points" },
  media: {
    maxImages: FACEBOOK_MAX_IMAGES,
    allowedMimeTypes: ["image/jpeg", "image/png"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: FACEBOOK_MAX_BYTES_PER_FILE,
    required: false,
  },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel"],
};
