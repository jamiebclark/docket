import type { ProviderCapabilities } from "../types";

// UNVERIFIED (not documented by Meta, checked 2026-10-07): the long-standing 10,000 Page post length.
export const FACEBOOK_MAX_TEXT = 10_000;
// Photo count is UNVERIFIED (not documented by Meta, checked 2026-10-07). Bytes per file: 10 MB, docs/research/meta.md, 2026-10-07.
export const FACEBOOK_MAX_IMAGES = 10;
export const FACEBOOK_MAX_BYTES_PER_FILE = 10_000_000;

export const facebookCapabilities: ProviderCapabilities = {
  text: { maxLength: FACEBOOK_MAX_TEXT, countingRule: "code_points" },
  media: {
    maxImages: FACEBOOK_MAX_IMAGES,
    // Formats verified against docs/research/meta.md, 2026-10-07.
    allowedMimeTypes: ["image/jpeg", "image/png"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: FACEBOOK_MAX_BYTES_PER_FILE,
    required: false,
  },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel"],
};
