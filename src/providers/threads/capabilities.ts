import type { ProviderCapabilities, PublishLimit, VideoCapabilities } from "../types";
import { threadsCountingRule } from "./text";

// R9 interim: 500 characters, emoji counted by UTF-8 bytes (see ./text.ts).
export const THREADS_MAX_TEXT = 500;
export const THREADS_MAX_IMAGES = 20;
export const THREADS_MAX_BYTES_PER_FILE = 8_000_000;

export const THREADS_MAX_ITEMS = 20; // carousel: 2 to 20 items, images and videos together

// docs/research/meta-video.md "Threads". Decimal gigabyte (D2). Scan, GOP, chroma and edit lists are not declared:
// Docket does not probe them. Bitrate, audio and index position come from the same table.
export const THREADS_VIDEO = {
  maxVideos: 1,
  withImages: false,
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  silentAllowed: true,
  maxBytes: 1_000_000_000,
  maxDurationSeconds: 300,
  maxWidth: 1920,
  minAspectRatio: 0.01,
  maxAspectRatio: 10,
  minFrameRate: 23,
  maxFrameRate: 60,
  maxVideoBitrate: 100_000_000, // "Video bitrate VBR, 100 Mbps max"
  audioBitrate: 128_000, // "Audio bitrate 128 kbps"
  maxAudioSampleRate: 48_000, // "AAC, 48 kHz max, 1 or 2 channels"
  maxAudioChannels: 2,
  indexAtFront: true, // "moov atom at front"
} as const satisfies VideoCapabilities;

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
  video: {
    ...THREADS_VIDEO,
    byPostType: {
      video: { recommendedAspectRatio: 9 / 16, notes: ["9:16 (vertical) is recommended."] },
      carousel: {
        maxVideos: THREADS_MAX_ITEMS,
        withImages: true,
        notes: ["A carousel holds 2 to 20 items, images and videos counted together."],
      },
    },
  },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel", "video"],
};

export const THREADS_DEFAULT_PUBLISH_LIMIT: PublishLimit = { count: 250, windowSeconds: 86_400 };
