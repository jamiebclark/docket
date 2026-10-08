import type { CreationAllowance, ProviderCapabilities, VideoCapabilities } from "../types";

// docs/research/bluesky-video.md: embed lexicon (video/mp4, 300,000,000 bytes) and "send H.264/AAC MP4"; codecs are not published.
// The 180 s ceiling is the research's conservative product limit (UNVERIFIED as a server limit).
export const BLUESKY_VIDEO = {
  maxVideos: 1,
  withImages: false,
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  silentAllowed: true,
  maxBytes: 300_000_000,
  maxDurationSeconds: 180,
} as const satisfies VideoCapabilities;

export const BLUESKY_VIDEO_NOTES = [
  "Bluesky allows about 25 videos (or 10 GB) a day per account; Docket checks the live allowance before each upload.",
  "Accounts hosted by Bluesky need a verified email address to post video.",
] as const;

export const BLUESKY_VIDEO_ALLOWANCE = {
  count: 25,
  windowSeconds: 86_400,
  name: "Bluesky's daily video upload allowance",
} as const satisfies CreationAllowance;

export const blueskyCapabilities: ProviderCapabilities = {
  text: { maxLength: 300, countingRule: "graphemes" },
  media: {
    maxImages: 4,
    allowedMimeTypes: ["image/jpeg", "image/png"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: 2_000_000,
    required: false,
  },
  video: { ...BLUESKY_VIDEO, byPostType: { video: { notes: BLUESKY_VIDEO_NOTES } } },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel", "video"],
};
