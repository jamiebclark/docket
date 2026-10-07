import type { ProviderCapabilities, PublishLimit } from "../types";
import { threadsCountingRule } from "./text";

// R9 interim: 500 characters, emoji counted by UTF-8 bytes (see ./text.ts).
export const THREADS_MAX_TEXT = 500;
export const THREADS_MAX_IMAGES = 20;
export const THREADS_MAX_BYTES_PER_FILE = 8_000_000;

export const threadsCapabilities: ProviderCapabilities = {
  text: { maxLength: THREADS_MAX_TEXT, countingRule: threadsCountingRule },
  media: {
    maxImages: THREADS_MAX_IMAGES,
    allowedMimeTypes: ["image/jpeg", "image/png"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: THREADS_MAX_BYTES_PER_FILE,
    minWidth: 320,
    maxWidth: 1440,
    minAspectRatio: 0.1,
    maxAspectRatio: 10,
    maxAltTextLength: 1000,
    required: false,
  },
  // Video is not accepted yet (018 D4).
  video: { maxVideos: 0 },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel"],
};

export const THREADS_DEFAULT_PUBLISH_LIMIT: PublishLimit = { count: 250, windowSeconds: 86_400 };
