import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_EDIT, type VideoEdit } from "../lib/video/edit";
import type { VideoCapabilities, VideoFacts } from "./types";
import { planVideo, previewRecipe, type VideoPlan, type VideoSource } from "./video-plan";

const IG: VideoCapabilities = {
  maxVideos: 1,
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  maxBytes: 300_000_000,
  minDurationSeconds: 3,
  maxDurationSeconds: 900,
  maxWidth: 1920,
  minAspectRatio: 0.01,
  maxAspectRatio: 10,
  minFrameRate: 23,
  maxFrameRate: 60,
  maxVideoBitrate: 25_000_000,
  audioBitrate: 128_000,
  maxAudioSampleRate: 48_000,
  maxAudioChannels: 2,
  indexAtFront: true,
  recommendedAspectRatio: 9 / 16,
};
const FB_REEL: VideoCapabilities = {
  maxVideos: 1,
  minDurationSeconds: 3,
  maxDurationSeconds: 90,
  minWidth: 540,
  minHeight: 960,
  minAspectRatio: 0.556,
  maxAspectRatio: 0.569,
  minFrameRate: 24,
  maxFrameRate: 60,
  audioBitrate: 128_000,
  maxAudioSampleRate: 48_000,
  maxAudioChannels: 2,
  recommendedAspectRatio: 9 / 16,
};
const FB_PAGE: VideoCapabilities = { maxVideos: 1, containers: ["mp4", "mov"] };
const THREADS: VideoCapabilities = {
  maxVideos: 1,
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  maxBytes: 1_000_000_000,
  maxDurationSeconds: 300,
  minAspectRatio: 0.01,
  maxAspectRatio: 10,
  maxFrameRate: 60,
  maxVideoBitrate: 100_000_000,
  audioBitrate: 128_000,
  maxAudioSampleRate: 48_000,
  maxAudioChannels: 2,
  indexAtFront: true,
  recommendedAspectRatio: 9 / 16,
};
const MOCK: VideoCapabilities = {
  maxVideos: 1,
  containers: ["mp4", "mov"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxBytes: 50_000_000,
  minDurationSeconds: 1,
  maxDurationSeconds: 60,
  minAspectRatio: 9 / 16,
  maxAspectRatio: 16 / 9,
  maxFrameRate: 60,
  maxWidth: 1920,
  maxHeight: 1920,
  maxVideoBitrate: 8_000_000,
  audioBitrate: 128_000,
  maxAudioSampleRate: 48_000,
  maxAudioChannels: 2,
  indexAtFront: true,
  recommendedAspectRatio: 9 / 16,
};

const facts = (over: Partial<VideoFacts> = {}): VideoFacts => ({
  container: "mp4",
  durationSeconds: 120,
  frameRate: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  videoBitrate: 12_000_000,
  audioBitrate: 128_000,
  audioSampleRate: 48_000,
  audioChannels: 2,
  indexAtFront: true,
  factsVersion: 2,
  ...over,
});
const source = (over: Omit<Partial<VideoSource>, "facts"> & { facts?: Partial<VideoFacts> } = {}): VideoSource => {
  const { facts: f, ...rest } = over;
  return { width: 1920, height: 1080, bytes: 180_000_000, ...rest, facts: facts(f) };
};
const edit = (over: Partial<VideoEdit> = {}): VideoEdit => ({ ...DEFAULT_VIDEO_EDIT, ...over });
const ctx = (typeLabel?: string, platform = "Instagram") => ({ index: 0, platform, typeLabel });

function derived(p: VideoPlan) {
  if (p.kind !== "derive") throw new Error(`expected derive, got ${p.kind}: ${JSON.stringify(p)}`);
  return p;
}
function refused(p: VideoPlan) {
  if (p.kind !== "refuse") throw new Error(`expected refuse, got ${p.kind}`);
  return p;
}

describe("planVideo: worked examples", () => {
  it("sends a video inside every limit as is", () => {
    expect(planVideo(source(), IG, edit(), ctx())).toEqual({ kind: "original" });
  });

  it("pads a 16:9 video to a Facebook Reel with a blurred copy, cut to 90 s", () => {
    const p = derived(planVideo(source(), FB_REEL, edit(), ctx("a Facebook Reel", "Facebook")));
    expect(p.mode).toBe("encode");
    expect(p.steps).toEqual(["cut", "pad"]);
    expect(p.recipe).toMatchObject({ startMs: 0, keptMs: 89_900, width: 1080, height: 1920 });
    expect(p.recipe.frame).toEqual({ kind: "pad", canvasW: 1080, canvasH: 1920, frameW: 1080, frameH: 606, x: 0, y: 656, fill: "blur" });
    expect(p.notes.map((n) => n.message)).toEqual([
      "Video 1 will be cut to the first 1:30 for a Facebook Reel.",
      "Video 1 will be padded to 9:16 with a blurred copy for a Facebook Reel.",
    ]);
    expect(p.output).toMatchObject({ container: "mp4", videoCodec: "h264", audioCodec: "aac", width: 1080, height: 1920, durationSeconds: 89.9 });
  });

  it("pads with a colour when asked", () => {
    const p = derived(planVideo(source(), FB_REEL, edit({ fit: "pad_color", padColor: "#ffffff" }), ctx("a Facebook Reel")));
    expect(p.recipe.frame).toMatchObject({ kind: "pad", fill: "#ffffff" });
    expect(p.notes[1]!.message).toBe("Video 1 will be padded to 9:16 with #ffffff bars for a Facebook Reel.");
  });

  it.each([
    [0.2, 80],
    [0.0, 0],
    [1.0, 1312],
    [0.5, 656],
  ])("crops 1920×1080 to 9:16 with the focal point at %s → x = %s", (focalX, x) => {
    const p = derived(planVideo(source(), FB_REEL, edit({ fit: "crop", focalX }), ctx("a Facebook Reel")));
    expect(p.recipe.frame).toEqual({ kind: "crop", x, y: 0, w: 608, h: 1080 });
    expect(p.recipe).toMatchObject({ width: 608, height: 1080 });
    expect(p.steps).toEqual(["cut", "crop"]);
  });

  it("keeps the crop inside the frame vertically too", () => {
    const p = derived(planVideo(source({ width: 1080, height: 1920 }), { maxVideos: 1, minAspectRatio: 1.7, maxAspectRatio: 1.8 }, edit({ fit: "crop", focalY: 1 }), ctx()));
    expect(p.recipe.frame).toMatchObject({ kind: "crop", x: 0, y: 1920 - 636, w: 1080, h: 636 });
  });

  it("pads 21:9 to the nearest end of the range, 16:9, when no shape is recommended", () => {
    const limits = { ...MOCK, recommendedAspectRatio: undefined };
    const p = derived(planVideo(source({ width: 2560, height: 1080, facts: { durationSeconds: 10, videoBitrate: 4_000_000 }, bytes: 6_000_000 }), limits, edit(), ctx("the mock", "Mock")));
    expect(p.recipe.frame).toEqual({ kind: "pad", canvasW: 1920, canvasH: 1080, frameW: 1920, frameH: 810, x: 0, y: 134, fill: "blur" });
    expect(p.steps).toEqual(["pad", "resize"]);
    expect(p.recipe).toMatchObject({ width: 1920, height: 1080 });
  });

  it("leaves a 9:16 video alone when the recommended shape is on and it already is 9:16", () => {
    const s = source({ width: 1080, height: 1920, bytes: 20_000_000, facts: { durationSeconds: 40, videoBitrate: 4_000_000 } });
    expect(planVideo(s, MOCK, edit({ recommendedShape: true }), ctx())).toEqual({ kind: "original" });
  });

  it("reframes to the recommended shape when asked, though the video is in range", () => {
    const s = source({ bytes: 20_000_000, facts: { durationSeconds: 10, videoBitrate: 4_000_000 } });
    const p = derived(planVideo(s, MOCK, edit({ recommendedShape: true }), ctx()));
    expect(p.steps).toEqual(["pad"]);
    expect(p.recipe.width / p.recipe.height).toBeCloseTo(9 / 16, 2);
  });

  it("refuses a video below the minimum size; it is never enlarged", () => {
    const p = refused(planVideo(source({ width: 360, height: 640, facts: { durationSeconds: 10 } }), FB_REEL, edit(), ctx("a Facebook Reel")));
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({ code: "video_too_small", message: "Video 1 is 360×640; a Facebook Reel needs at least 540×960.", field: "media.0" });
  });

  it("lets padding rescue a small landscape video, since the canvas may exceed the source", () => {
    const p = derived(planVideo(source({ width: 640, height: 360, facts: { durationSeconds: 10 } }), FB_REEL, edit(), ctx()));
    expect(p.recipe).toMatchObject({ width: 640, height: 1138 });
  });

  it("refuses a too-short video, naming the selection when trimmed", () => {
    const p = refused(planVideo(source({ width: 1280, height: 720, facts: { durationSeconds: 2 } }), FB_REEL, edit(), ctx("a Facebook Reel")));
    expect(p.issues[0]).toMatchObject({ code: "video_too_short", message: "Video 1 is 2 seconds long; a Facebook Reel needs at least 3 seconds." });
    const t = refused(planVideo(source({ facts: { durationSeconds: 60 } }), FB_REEL, edit({ trimStartMs: 1000, trimEndMs: 3000 }), ctx("a Facebook Reel")));
    expect(t.issues[0]!.message).toBe("Your selection of Video 1 is 2 seconds long; a Facebook Reel needs at least 3 seconds.");
  });

  it("collects every refusal", () => {
    const p = refused(planVideo(source({ width: 360, height: 640, facts: { durationSeconds: 2 } }), FB_REEL, edit(), ctx()));
    expect(p.issues.map((i) => i.code).sort()).toEqual(["video_too_short", "video_too_small"]);
  });

  it("trims for Threads: a user trim is a cut", () => {
    const s = source({ width: 1280, height: 720, facts: { durationSeconds: 600 }, bytes: 50_000_000 });
    const p = derived(planVideo(s, THREADS, edit({ trimStartMs: 135_000, trimEndMs: 240_000 }), ctx(undefined, "Threads")));
    expect(p.recipe).toMatchObject({ startMs: 135_000, keptMs: 105_000 });
    expect(p.steps).toEqual(["cut"]);
    expect(p.notes[0]!.message).toBe("Video 1 will be trimmed to 2:15–4:00 for Threads.");
  });

  it("cuts a trimmed selection to the target's maximum", () => {
    const s = source({ width: 1280, height: 720, facts: { durationSeconds: 600 }, bytes: 50_000_000 });
    const p = derived(planVideo(s, FB_REEL, edit({ trimStartMs: 135_000, trimEndMs: 240_000 }), ctx("a Facebook Reel")));
    expect(p.recipe).toMatchObject({ startMs: 135_000, keptMs: 89_900 });
    expect(p.notes[0]!.message).toBe("Video 1 will be cut to the first 1:30 of your selection for a Facebook Reel.");
  });

  it("treats a trim equal to the whole video as no trim", () => {
    expect(planVideo(source(), IG, edit({ trimStartMs: 0, trimEndMs: 120_000 }), ctx())).toEqual({ kind: "original" });
    expect(planVideo(source(), IG, edit({ trimEndMs: 119_960 }), ctx())).toEqual({ kind: "original" });
  });

  it("rewraps a MOV for an MP4-only target, without re-encoding", () => {
    const p = derived(planVideo(source({ facts: { container: "mov" } }), { ...IG, containers: ["mp4"] }, edit(), ctx()));
    expect(p.mode).toBe("rewrap");
    expect(p.steps).toEqual(["rewrap"]);
    expect(p.recipe).toMatchObject({ container: "mp4", width: 1920, height: 1080, keptMs: 120_000 });
    expect(p.output).toMatchObject({ container: "mp4", videoCodec: "h264", durationSeconds: 120 });
    expect(p.notes[0]!.message).toBe("Video 1 will be rewrapped as MP4 for Instagram, without re-encoding.");
  });

  it("rewraps an MP4 whose index is at the end when the target needs it at the front", () => {
    const p = derived(planVideo(source({ facts: { indexAtFront: false } }), IG, edit(), ctx()));
    expect(p.mode).toBe("rewrap");
    expect(p.recipe.container).toBe("mp4");
    expect(derived(planVideo(source({ facts: { container: "mov", indexAtFront: false } }), IG, edit(), ctx())).recipe.container).toBe("mov");
  });

  it("treats an unknown index position as not at the front", () => {
    expect(planVideo(source({ facts: { indexAtFront: null } }), IG, edit(), ctx()).kind).toBe("derive");
  });

  it("sends the original to a target with no index requirement", () => {
    expect(planVideo(source({ facts: { indexAtFront: false } }), FB_PAGE, edit(), ctx())).toEqual({ kind: "original" });
  });

  it("re-encodes HEVC above the bitrate ceiling", () => {
    const p = derived(planVideo(source({ facts: { videoCodec: "hevc", videoBitrate: 50_000_000 } }), IG, edit(), ctx()));
    expect(p.mode).toBe("encode");
    expect(p.steps).toEqual(["reencode"]);
    // the lower of the platform's ceiling and what keeps 120 s inside 300 MB
    expect(p.recipe.video.maxBitrate).toBe(Math.floor((300_000_000 * 8 * 0.95) / 120) - 128_000);
    expect(planVideo(source({ bytes: 20_000_000, facts: { videoCodec: "hevc", videoBitrate: 50_000_000 } }), { ...IG, maxBytes: undefined }, edit(), ctx())).toMatchObject({ recipe: { video: { maxBitrate: 25_000_000 } } });
  });

  it("falls back to the file's average bitrate when the stream's is unknown", () => {
    const heavy = source({ bytes: 290_000_000, facts: { videoBitrate: null, durationSeconds: 60 } });
    expect(planVideo(heavy, IG, edit(), ctx()).kind).toBe("derive");
    const light = source({ bytes: 20_000_000, facts: { videoBitrate: null, durationSeconds: 60 } });
    expect(planVideo(light, IG, edit(), ctx()).kind).toBe("original");
  });

  it("brings frame rates into range", () => {
    const hi = derived(planVideo(source({ facts: { frameRate: 120 } }), THREADS, edit(), ctx(undefined, "Threads")));
    expect(hi.recipe.frameRate).toBe(60);
    expect(hi.steps).toEqual(["frame_rate"]);
    expect(hi.notes[0]!.message).toBe("Video 1's frame rate will be changed to 60 fps for Threads.");
    expect(derived(planVideo(source({ facts: { frameRate: 15 } }), IG, edit(), ctx())).recipe.frameRate).toBe(23);
  });

  it("keeps a variable frame rate inside the range", () => {
    expect(planVideo(source({ facts: { frameRate: 29.97 } }), IG, edit(), ctx())).toEqual({ kind: "original" });
  });

  it("does not guess an unknown frame rate", () => {
    expect(planVideo(source({ facts: { frameRate: null } }), IG, edit(), ctx())).toEqual({ kind: "original" });
  });

  it("limits audio, and keeps silence silent", () => {
    const p = derived(planVideo(source({ facts: { audioSampleRate: 96_000, audioChannels: 6 } }), IG, edit(), ctx()));
    expect(p.recipe.audio).toEqual({ sampleRate: 48_000, channels: 2, bitrate: 128_000 });
    const silent = derived(planVideo(source({ facts: { audioCodec: null, audioBitrate: null, audioSampleRate: null, audioChannels: null, videoCodec: "vp9" } }), IG, edit(), ctx()));
    expect(silent.recipe.audio).toBeNull();
    expect(silent.output.audioCodec).toBeNull();
  });

  it("keeps a mono source mono", () => {
    const p = derived(planVideo(source({ facts: { audioCodec: "mp3", audioChannels: 1 } }), IG, edit(), ctx()));
    expect(p.recipe.audio).toMatchObject({ channels: 1 });
  });

  it("fits a long video to a size limit with a bitrate budget", () => {
    const s = source({ bytes: 350_000_000, facts: { durationSeconds: 900, videoBitrate: 3_000_000 } });
    const p = derived(planVideo(s, IG, edit(), ctx()));
    expect(p.recipe.video.maxBytes).toBe(300_000_000);
    expect(p.recipe.video.maxBitrate).toBe(Math.min(25_000_000, Math.floor((300_000_000 * 8 * 0.95) / 900) - 128_000));
    expect(p.output.maxBytes).toBe(300_000_000);
  });

  it("refuses when no bitrate can meet the size limit", () => {
    const p = refused(planVideo(source({ bytes: 2_000_000, facts: { durationSeconds: 900, videoBitrate: 20_000 } }), { ...IG, maxBytes: 1_000_000 }, edit(), ctx("an Instagram Reel")));
    expect(p.issues[0]).toMatchObject({ code: "video_too_large", message: "Video 1 could not be made smaller than 1 MB for an Instagram Reel." });
  });

  it("reduces a 4K video to the width limit", () => {
    const s = source({ width: 3840, height: 2160, bytes: 900_000_000, facts: { durationSeconds: 900, videoBitrate: 8_000_000 } });
    const p = derived(planVideo(s, IG, edit(), ctx()));
    expect(p.steps).toEqual(["resize"]);
    expect(p.recipe).toMatchObject({ width: 1920, height: 1080 });
    expect(p.notes[0]!.message).toBe("Video 1 will be resized to 1920×1080 for Instagram.");
  });

  it("makes odd sizes even without a resize step when re-encoding for another reason", () => {
    const p = derived(planVideo(source({ width: 1281, height: 721, facts: { frameRate: 15 } }), IG, edit(), ctx()));
    expect(p.recipe).toMatchObject({ width: 1280, height: 720 });
    expect(p.steps).toEqual(["frame_rate"]);
  });

  it("sends an odd-sized video as is when nothing else needs a re-encode", () => {
    expect(planVideo(source({ width: 1281, height: 721 }), IG, edit(), ctx())).toEqual({ kind: "original" });
  });

  it("refuses a container the target cannot be given", () => {
    const p = refused(planVideo(source({ facts: { frameRate: 15 } }), { ...IG, containers: ["mov"] }, edit(), ctx()));
    expect(p.issues[0]!.code).toBe("video_container_not_allowed");
  });

  it("answers `checking` while the facts are being read, whatever the limits", () => {
    const p = planVideo(source({ facts: { factsVersion: 1 } }), IG, edit(), ctx());
    expect(p).toMatchObject({ kind: "checking" });
    if (p.kind === "checking") expect(p.notes[0]).toMatchObject({ severity: "info", code: "video_checking", message: "Docket is still reading Video 1's details." });
  });

  it("refuses when the facts could not be read", () => {
    const p = refused(planVideo(source({ facts: { factsUnreadable: true } }), IG, edit(), ctx()));
    expect(p.issues[0]).toMatchObject({ code: "video_facts_unreadable", message: "Docket could not read Video 1's details; upload it again." });
  });

  it("uses the item's position in the label", () => {
    const p = refused(planVideo(source({ facts: { factsUnreadable: true } }), IG, edit(), { index: 2, platform: "Instagram" }));
    expect(p.issues[0]).toMatchObject({ field: "media.2" });
    expect(p.issues[0]!.message).toContain("Video 3");
  });

  it("gives identical limits and edits identical recipes (one key)", () => {
    const a = planVideo(source(), FB_REEL, edit(), ctx("a Facebook Reel"));
    const b = planVideo(source(), { ...FB_REEL }, edit(), ctx("a Facebook Reel", "Facebook"));
    expect(derived(a).recipe).toEqual(derived(b).recipe);
  });

  it("ignores edit fields that do not change the output (P2)", () => {
    const crop = (e: Partial<VideoEdit>) => derived(planVideo(source(), FB_REEL, edit({ fit: "crop", ...e }), ctx())).recipe;
    expect(crop({ padColor: "#ffffff" })).toEqual(crop({}));
    const pad = (e: Partial<VideoEdit>) => derived(planVideo(source(), FB_REEL, edit({ fit: "pad_blur", ...e }), ctx())).recipe;
    expect(pad({ focalX: 0.1, focalY: 0.9 })).toEqual(pad({}));
  });

  it("is total: odd inputs never throw", () => {
    const odd = [
      edit({ trimStartMs: 500_000, trimEndMs: 1000 }),
      edit({ trimStartMs: 119_000, trimEndMs: null }),
      edit({ trimEndMs: 0 }),
    ];
    for (const e of odd) expect(() => planVideo(source(), FB_REEL, e, ctx())).not.toThrow();
    expect(() => planVideo(source({ width: 2, height: 2 }), FB_REEL, edit(), ctx())).not.toThrow();
  });
});

describe("planVideo: each declared bound (FR-038)", () => {
  const s = (over: Parameters<typeof source>[0] = {}) => source({ bytes: 20_000_000, facts: { durationSeconds: 30, videoBitrate: 4_000_000 }, ...over });

  it("maxBytes: as is, adapt, refuse", () => {
    expect(planVideo(s(), { ...IG, maxBytes: 20_000_000 }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s(), { ...IG, maxBytes: 10_000_000 }, edit(), ctx())).recipe.video.maxBytes).toBe(10_000_000);
    expect(planVideo(s({ facts: { durationSeconds: 3600 } }), { ...IG, maxBytes: 10_000_000, maxDurationSeconds: 4000 }, edit(), ctx()).kind).toBe("refuse");
  });
  it("duration: as is, adapt (cut), refuse (short)", () => {
    expect(planVideo(s(), { ...IG, maxDurationSeconds: 30 }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s(), { ...IG, maxDurationSeconds: 20 }, edit(), ctx())).recipe.keptMs).toBe(19_900);
    expect(planVideo(s(), { ...IG, minDurationSeconds: 31 }, edit(), ctx()).kind).toBe("refuse");
  });
  it("width and height: as is, adapt (resize), refuse (small)", () => {
    expect(planVideo(s(), { ...IG, maxWidth: 1920, maxHeight: 1080 }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s(), { ...IG, maxHeight: 540 }, edit(), ctx())).recipe).toMatchObject({ width: 960, height: 540 });
    expect(planVideo(s(), { ...IG, minWidth: 2000 }, edit(), ctx()).kind).toBe("refuse");
    expect(planVideo(s(), { ...IG, minHeight: 2000 }, edit(), ctx()).kind).toBe("refuse");
  });
  it("aspect ratio: as is, adapt (pad), and the reframe lands inside the range", () => {
    expect(planVideo(s(), { ...IG, minAspectRatio: 1, maxAspectRatio: 2, recommendedAspectRatio: undefined }, edit(), ctx()).kind).toBe("original");
    const p = derived(planVideo(s(), { ...IG, minAspectRatio: 0.8, maxAspectRatio: 1.25, recommendedAspectRatio: undefined }, edit(), ctx()));
    expect(p.recipe.width / p.recipe.height).toBeCloseTo(1.25, 1);
  });
  it("frame rate: as is, adapt up and down", () => {
    expect(planVideo(s(), { ...IG, minFrameRate: 30, maxFrameRate: 30 }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s(), { ...IG, maxFrameRate: 24 }, edit(), ctx())).recipe.frameRate).toBe(24);
    expect(derived(planVideo(s(), { ...IG, minFrameRate: 48 }, edit(), ctx())).recipe.frameRate).toBe(48);
  });
  it("containers: as is, adapt (rewrap), refuse (nothing producible)", () => {
    expect(planVideo(s(), { ...IG, containers: ["mp4"] }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s({ facts: { container: "mov" } }), { ...IG, containers: ["mp4"] }, edit(), ctx())).mode).toBe("rewrap");
    expect(planVideo(s({ facts: { frameRate: 10 } }), { ...IG, containers: ["mov"] }, edit(), ctx()).kind).toBe("refuse");
  });
  it("codecs: as is, adapt", () => {
    expect(planVideo(s(), { ...IG, videoCodecs: ["h264"], audioCodecs: ["aac"] }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s({ facts: { videoCodec: "vp9" } }), { ...IG, videoCodecs: ["h264"] }, edit(), ctx())).mode).toBe("encode");
    expect(derived(planVideo(s({ facts: { audioCodec: "opus" } }), { ...IG, audioCodecs: ["aac"] }, edit(), ctx())).recipe.audio).not.toBeNull();
  });
  it("video bitrate: as is, adapt", () => {
    expect(planVideo(s(), { ...IG, maxVideoBitrate: 4_000_000 }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s(), { ...IG, maxVideoBitrate: 3_000_000 }, edit(), ctx())).recipe.video.maxBitrate).toBe(3_000_000);
  });
  it("audio sample rate and channels: as is, adapt", () => {
    expect(planVideo(s(), { ...IG, maxAudioSampleRate: 48_000, maxAudioChannels: 2 }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s(), { ...IG, maxAudioSampleRate: 44_100 }, edit(), ctx())).recipe.audio).toMatchObject({ sampleRate: 44_100 });
    expect(derived(planVideo(s(), { ...IG, maxAudioChannels: 1 }, edit(), ctx())).recipe.audio).toMatchObject({ channels: 1 });
  });
  it("audio bitrate is the encode target, never a refusal", () => {
    expect(planVideo(s({ facts: { audioBitrate: 320_000 } }), { ...IG, audioBitrate: 96_000 }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s({ facts: { frameRate: 10 } }), { ...IG, audioBitrate: 96_000 }, edit(), ctx())).recipe.audio).toMatchObject({ bitrate: 96_000 });
  });
  it("index at the front: as is, adapt", () => {
    expect(planVideo(s(), { ...IG, indexAtFront: true }, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s({ facts: { indexAtFront: false } }), { ...IG, indexAtFront: true }, edit(), ctx())).mode).toBe("rewrap");
  });
  it("recommended shape: only when asked, or when forced by the range", () => {
    expect(planVideo(s(), IG, edit(), ctx()).kind).toBe("original");
    expect(derived(planVideo(s(), IG, edit({ recommendedShape: true }), ctx())).steps).toContain("pad");
    expect(planVideo(s(), { ...IG, recommendedAspectRatio: undefined }, edit({ recommendedShape: true }), ctx()).kind).toBe("original");
  });
  it("a target with no limits receives the original", () => {
    expect(planVideo(s(), { maxVideos: 1 }, edit(), ctx())).toEqual({ kind: "original" });
    expect(planVideo(s(), FB_PAGE, edit(), ctx())).toEqual({ kind: "original" });
  });
  it("a trim re-encodes even for a target with no limits", () => {
    expect(derived(planVideo(s(), FB_PAGE, edit({ trimStartMs: 1000 }), ctx())).steps).toEqual(["cut"]);
  });
});

describe("previewRecipe", () => {
  it("shrinks to 640 px on the long side, caps fps and drops byte fitting", () => {
    const p = derived(planVideo(source(), FB_REEL, edit(), ctx()));
    const v = previewRecipe(p.recipe);
    expect(Math.max(v.width, v.height)).toBeLessThanOrEqual(640);
    expect(v.video).toMatchObject({ maxBytes: null, maxBitrate: null });
    expect(v.frame.kind).toBe("pad");
    if (v.frame.kind === "pad") {
      expect(v.frame.canvasW).toBe(v.width);
      expect(v.frame.canvasH).toBe(v.height);
      expect(v.frame.y % 2).toBe(0);
    }
    expect(v.width % 2 + v.height % 2).toBe(0);
  });
  it("caps a known source frame rate at 30", () => {
    const p = derived(planVideo(source({ facts: { frameRate: 60 } }), FB_REEL, edit(), ctx()));
    expect(previewRecipe(p.recipe, 60).frameRate).toBe(30);
    expect(previewRecipe(p.recipe, 24).frameRate).toBeNull();
  });
  it("leaves a small recipe's geometry alone", () => {
    const p = derived(planVideo(source({ width: 320, height: 180, facts: { durationSeconds: 10 } }), { ...MOCK, recommendedAspectRatio: undefined }, edit({ trimStartMs: 1000 }), ctx()));
    expect(previewRecipe(p.recipe).width).toBe(p.recipe.width);
  });
  it("turns a rewrap into an encode of the whole video", () => {
    const p = derived(planVideo(source({ facts: { indexAtFront: false } }), IG, edit(), ctx()));
    expect(previewRecipe(p.recipe)).toMatchObject({ mode: "encode", container: "mp4", keptMs: 120_000 });
  });
});
