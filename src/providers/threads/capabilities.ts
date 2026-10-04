import type { ProviderCapabilities, PublishLimit } from "../types";

// Stub (T002): interim values; the real counting rule and limits land with the capabilities task.
export const THREADS_MAX_TEXT = 500;
export const THREADS_MAX_IMAGES = 20;

export const threadsCapabilities: ProviderCapabilities = {
  text: { maxLength: THREADS_MAX_TEXT, countingRule: "graphemes" },
  media: {
    maxImages: THREADS_MAX_IMAGES,
    allowedMimeTypes: ["image/jpeg"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: 8_000_000,
    required: false,
  },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel"],
};

export const THREADS_DEFAULT_PUBLISH_LIMIT: PublishLimit = { count: 250, windowSeconds: 86_400 };
