import type { ProviderCapabilities, VideoCapabilities, VideoLimitOverrides } from "../types";

// UNVERIFIED (not documented by Meta, checked 2026-10-07): the long-standing 10,000 Page post length.
export const FACEBOOK_MAX_TEXT = 10_000;
// Photo count is UNVERIFIED (not documented by Meta, checked 2026-10-07). Bytes per file: 10 MB, docs/research/meta.md, 2026-10-07.
export const FACEBOOK_MAX_IMAGES = 10;
export const FACEBOOK_MAX_BYTES_PER_FILE = 10_000_000;

// docs/research/meta-video.md "Regular Page video": no size, length or format limits published.
export const FACEBOOK_PAGE_VIDEO = { maxVideos: 1, withImages: false, containers: ["mp4", "mov"] } as const satisfies VideoCapabilities;

// docs/research/meta-video.md "Reels Publishing API" specs table; aspect 9:16 ±1%.
export const FACEBOOK_REEL_VIDEO = {
  videoCodecs: ["h264", "hevc", "vp9", "av1"],
  audioCodecs: ["aac"],
  silentAllowed: true,
  minDurationSeconds: 3,
  maxDurationSeconds: 90,
  minWidth: 540,
  minHeight: 960,
  minAspectRatio: 0.556,
  maxAspectRatio: 0.569,
  minFrameRate: 24,
  maxFrameRate: 60,
} as const satisfies VideoLimitOverrides;

export const FACEBOOK_REELS_PER_DAY = 30; // "30 API-published posts within a 24-hour moving period"

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
  video: {
    ...FACEBOOK_PAGE_VIDEO,
    byPostType: {
      video: { notes: ["Facebook publishes no length or size limits for Page videos; Docket's upload limits apply."] },
      reel: {
        ...FACEBOOK_REEL_VIDEO,
        notes: [
          "9:16 (vertical) only.",
          "Facebook publishes no size limit for Reels; Docket's upload limit applies.",
          "Facebook allows 30 Reels per Page a day.",
        ],
      },
    },
  },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel", "video", "reel"],
  postTypeChoices: [
    {
      shape: "single_video",
      default: "video",
      options: [
        { type: "video", label: "Page video", description: "A video post on your Page. Any shape or length Facebook accepts." },
        { type: "reel", label: "Reel", description: "A vertical 9:16 video of 3 to 90 seconds, shown in Reels." },
      ],
    },
  ],
};
