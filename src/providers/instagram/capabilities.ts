import type { ProviderCapabilities, VideoCapabilities } from "../types";

// R1 interim: Instagram captions are limited to 2,200 characters.
export const INSTAGRAM_MAX_TEXT = 2_200;
export const INSTAGRAM_MAX_IMAGES = 10;
export const INSTAGRAM_MAX_BYTES_PER_FILE = 8_000_000;

// docs/research/meta-video.md "Reel specs". Decimal megabytes (D5). Bitrate, sample rate and the like are not declared.
export const INSTAGRAM_REEL_VIDEO = {
  maxVideos: 1,
  withImages: false,
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  silentAllowed: true,
  maxBytes: 300_000_000,
  minDurationSeconds: 3,
  maxDurationSeconds: 900,
  maxWidth: 1920,
  minAspectRatio: 0.01,
  maxAspectRatio: 10,
  minFrameRate: 23,
  maxFrameRate: 60,
} as const satisfies VideoCapabilities;

export const instagramCapabilities: ProviderCapabilities = {
  text: {
    maxLength: INSTAGRAM_MAX_TEXT,
    countingRule: "code_points",
    // Limits verification, 2026-10-07: docs/research/meta.md.
    maxHashtags: 30,
    maxMentions: 20,
  },
  media: {
    maxImages: INSTAGRAM_MAX_IMAGES,
    allowedMimeTypes: ["image/jpeg"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: INSTAGRAM_MAX_BYTES_PER_FILE,
    minWidth: 320,
    maxWidth: 1440,
    minAspectRatio: 0.8,
    maxAspectRatio: 1.91,
    maxAltTextLength: 1000,
    required: true,
  },
  video: {
    ...INSTAGRAM_REEL_VIDEO,
    byPostType: {
      // docs/research/meta-video.md "Carousel with video": a mix of images and videos, up to 10 items.
      // No carousel video spec is published, so the conservative image aspect range applies (UNVERIFIED).
      carousel: {
        maxVideos: 10,
        withImages: true,
        minAspectRatio: 0.8,
        maxAspectRatio: 1.91,
        notes: ["Reels cannot be carousel items."],
      },
    },
  },
  textOnlyAllowed: false,
  postTypes: ["image", "carousel", "video", "reel"],
  postTypeChoices: [
    {
      shape: "single_video",
      default: "video",
      options: [
        { type: "video", label: "Feed video", description: "Shown on your profile and feed, and in the Reels tab." },
        { type: "reel", label: "Reel", description: "Shown in the Reels tab only." },
      ],
    },
  ],
};

// Docket allows 50 a day; Meta's own quota (read at run time) is 100. docs/research/meta.md, 2026-10-07.
export const INSTAGRAM_DEFAULT_PUBLISH_LIMIT = { count: 50, windowSeconds: 86_400 } as const;
