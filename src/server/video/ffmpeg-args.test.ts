import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_EDIT, type VideoEdit } from "../../lib/video/edit";
import type { VideoFacts } from "../../providers/types";
import { planVideo, type VideoRecipe } from "../../providers/video-plan";
import { USED_OPTIONS, encodeArgs, encodeTimeoutMs, filterGraph, rewrapArgs } from "./ffmpeg-args";

const REEL = {
  maxVideos: 1,
  maxDurationSeconds: 90,
  minAspectRatio: 0.556,
  maxAspectRatio: 0.569,
  recommendedAspectRatio: 9 / 16,
  audioBitrate: 128_000,
};
const facts: VideoFacts = { container: "mp4" as const, durationSeconds: 120, frameRate: 30, videoCodec: "h264", audioCodec: "aac", audioSampleRate: 48_000, audioChannels: 2, factsVersion: 2 };
const source = { width: 1920, height: 1080, bytes: 100_000_000, facts };

function recipeFor(edit: Partial<VideoEdit> = {}, limits: object = REEL, src = source): VideoRecipe {
  const p = planVideo(src, { ...REEL, ...limits }, { ...DEFAULT_VIDEO_EDIT, ...edit }, { index: 0, platform: "X" });
  if (p.kind !== "derive") throw new Error(p.kind);
  return p.recipe;
}
const args = (r: VideoRecipe, o: { preview?: boolean; bitrate?: number | null } = {}) => encodeArgs("in.mp4", "out.mp4", r, { videoBitrate: o.bitrate ?? null }, { preview: o.preview ?? false });
const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

describe("filterGraph: crop with a focal point", () => {
  it.each([
    [0.5, 656],
    [0.2, 80],
    [0.0, 0],
    [1.0, 1312],
    [0.97, 1312],
    [0.03, 0],
  ])("focal %s crops 608×1080 at x = %s", (focalX, x) => {
    const g = filterGraph(recipeFor({ fit: "crop", focalX }));
    expect(g).toEqual({ graph: `crop=608:1080:${x}:0,scale=608:1080,setsar=1,format=yuv420p`.replace("scale=608:1080,", ""), complex: false });
  });
  it("scales a crop that is also reduced", () => {
    const r = recipeFor({ fit: "crop" }, { maxHeight: 720 });
    expect(filterGraph(r).graph).toMatch(/^crop=608:1080:656:0,scale=404:720,setsar=1,format=yuv420p$/);
  });
  it("puts fps first", () => {
    const r = recipeFor({ fit: "crop" }, { maxFrameRate: 24 });
    expect(filterGraph(r).graph.startsWith("fps=24,crop=")).toBe(true);
  });
});

describe("filterGraph: pad", () => {
  it("blurs a copy behind the frame", () => {
    const g = filterGraph(recipeFor());
    expect(g.complex).toBe(true);
    expect(g.graph).toBe(
      "[0:v]split=2[bg][fg];" +
        "[bg]scale=854:480,crop=270:480,boxblur=luma_radius=10:luma_power=2,scale=1080:1920[b];" +
        "[fg]scale=1080:606[f];" +
        "[b][f]overlay=0:656,setsar=1,format=yuv420p[v]",
    );
  });
  it("covers the quarter canvas for a tall source too", () => {
    const g = filterGraph(recipeFor({}, { minAspectRatio: 1.7, maxAspectRatio: 1.8, recommendedAspectRatio: undefined }, { ...source, width: 1080, height: 1920 })).graph;
    expect(g).toMatch(/\[bg\]scale=\d+:\d+,crop=\d+:\d+,boxblur/);
    const [, bw, bh, qw, qh] = /scale=(\d+):(\d+),crop=(\d+):(\d+)/.exec(g)!.map(Number);
    expect(bw).toBeGreaterThanOrEqual(qw!);
    expect(bh).toBeGreaterThanOrEqual(qh!);
  });
  it("keeps the blur radius inside boxblur's limit on a small canvas", () => {
    const r = recipeFor({}, { minWidth: undefined, minHeight: undefined, maxDurationSeconds: undefined }, { ...source, width: 64, height: 36 });
    expect(filterGraph(r).graph).toMatch(/luma_radius=(\d+):/);
    const radius = Number(/luma_radius=(\d+)/.exec(filterGraph(r).graph)![1]);
    expect(radius).toBeGreaterThanOrEqual(1);
    expect(radius).toBeLessThanOrEqual(10);
  });
  it("pads with a solid colour", () => {
    const g = filterGraph(recipeFor({ fit: "pad_color", padColor: "#FFFFFF" }));
    expect(g).toEqual({ graph: "scale=1080:606,pad=1080:1920:0:656:color=0xffffff,setsar=1,format=yuv420p", complex: false });
  });
  it("puts fps in front of the blur split", () => {
    expect(filterGraph(recipeFor({}, { maxFrameRate: 24 })).graph.startsWith("[0:v]fps=24,split=2[bg][fg];")).toBe(true);
  });
  it("falls back to black for a malformed colour", () => {
    const r = recipeFor({ fit: "pad_color" });
    if (r.frame.kind === "pad") r.frame.fill = "#zzz" as `#${string}`;
    expect(filterGraph(r).graph).toContain("color=0x000000");
  });
});

describe("filterGraph: no reframe", () => {
  it("only fixes the size and pixel format", () => {
    const r = recipeFor({ trimStartMs: 1000 }, { maxDurationSeconds: undefined, minAspectRatio: undefined, maxAspectRatio: undefined, recommendedAspectRatio: undefined });
    expect(filterGraph(r)).toEqual({ graph: "scale=1920:1080,setsar=1,format=yuv420p", complex: false });
  });
});

describe("encodeArgs", () => {
  const r = recipeFor();
  it("starts with the common prefix and never uses -fs", () => {
    const a = args(r);
    expect(a.slice(0, 5)).toEqual(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    expect(a).not.toContain("-fs");
    expect(args(r, { bitrate: 1_000_000 })).not.toContain("-fs");
    expect(args(r, { preview: true })).not.toContain("-fs");
  });
  it("omits -ss for a cut that starts at 0 and always passes -t", () => {
    const a = args(r);
    expect(a).not.toContain("-ss");
    expect(after(a, "-t")).toBe("89.900");
    expect(a.indexOf("-i")).toBeLessThan(a.indexOf("-t"));
  });
  it("seeks before the input for a trim start", () => {
    const t = recipeFor({ trimStartMs: 35_000, trimEndMs: 100_000 });
    const a = args(t);
    expect(after(a, "-ss")).toBe("35.000");
    expect(a.indexOf("-ss")).toBeLessThan(a.indexOf("-i"));
    expect(after(a, "-t")).toBe("65.000");
  });
  it("cuts 100 ms under a target's maximum", () => {
    expect(after(args(recipeFor({}, { maxDurationSeconds: 30 })), "-t")).toBe("29.900");
  });
  it("encodes H.264 High yuv420p with AAC and faststart", () => {
    const a = args(r);
    expect(a).toEqual(expect.arrayContaining(["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23"]));
    expect(a).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "128000", "-ar", "48000", "-ac", "2"]));
    expect(a.slice(-5)).toEqual(["-movflags", "+faststart", "-f", "mp4", "out.mp4"]);
    expect(a).toEqual(expect.arrayContaining(["-map", "0:a:0?"]));
  });
  it("maps the blurred pad's labelled output", () => {
    const a = args(r);
    expect(after(a, "-filter_complex")).toContain("[v]");
    expect(after(a, "-map")).toBe("[v]");
    expect(a).not.toContain("-vf");
  });
  it("uses -vf for a plain chain", () => {
    const a = args(recipeFor({ fit: "crop" }));
    expect(after(a, "-vf")).toMatch(/^crop=/);
    expect(a).not.toContain("-filter_complex");
  });
  it("sets the frame rate, and a keyframe every two seconds", () => {
    const a = args(recipeFor({}, { maxFrameRate: 24 }, { ...source, facts: { ...facts, frameRate: 60 } }));
    expect(a.join(" ")).toContain("fps=24");
    expect(after(a, "-g")).toBe("48");
    expect(after(args(r), "-g")).toBe("60");
  });
  it("caps the rate only when a cap exists", () => {
    expect(args(r)).not.toContain("-maxrate");
    const capped = args(recipeFor({}, { maxVideoBitrate: 8_000_000 }));
    expect(after(capped, "-maxrate")).toBe("8000000");
    expect(after(capped, "-bufsize")).toBe("16000000");
  });
  it("lets the size-fit loop override the cap", () => {
    const a = args(recipeFor({}, { maxVideoBitrate: 8_000_000 }), { bitrate: 3_000_000 });
    expect(after(a, "-maxrate")).toBe("3000000");
    expect(after(a, "-bufsize")).toBe("6000000");
  });
  it("keeps a silent video silent", () => {
    const a = args(recipeFor({}, {}, { ...source, facts: { ...facts, audioCodec: null } }));
    expect(a).toContain("-an");
    expect(a).not.toContain("-c:a");
    expect(a).not.toContain("0:a:0?");
  });
  it("uses a lighter preset for a preview", () => {
    const a = args(r, { preview: true });
    expect(after(a, "-preset")).toBe("ultrafast");
    expect(after(a, "-crf")).toBe("30");
  });
  it("drops metadata and chapters", () => {
    expect(args(r)).toEqual(expect.arrayContaining(["-map_metadata", "-1", "-map_chapters", "-1"]));
  });
});

describe("rewrapArgs", () => {
  const r = recipeFor({}, { containers: ["mp4"], indexAtFront: true, minAspectRatio: undefined, maxAspectRatio: undefined, maxDurationSeconds: undefined, recommendedAspectRatio: undefined });
  const rewrap: VideoRecipe = { ...r, mode: "rewrap", container: "mov" };
  it("copies streams, keeps metadata and moves the index to the front", () => {
    const a = rewrapArgs("in.mov", "out.mov", rewrap, 0, "none");
    expect(a).toEqual(expect.arrayContaining(["-c", "copy", "-movflags", "+faststart", "-f", "mov"]));
    expect(a).not.toContain("-map_metadata");
    expect(a.at(-1)).toBe("out.mov");
  });
  it("re-applies a rotation the way clean does", () => {
    expect(rewrapArgs("a", "b", rewrap, 90, "display").slice(5, 7)).toEqual(["-display_rotation:v:0", "90"]);
    expect(rewrapArgs("a", "b", rewrap, 90, "tag")).toEqual(expect.arrayContaining(["-metadata:s:v:0", "rotate=270"]));
  });
});

describe("encodeTimeoutMs", () => {
  it("allows 120 s plus 2 s per kept second, to an hour", () => {
    expect(encodeTimeoutMs(90_000, false)).toBe(120_000 + 180_000);
    expect(encodeTimeoutMs(10_000_000, false)).toBe(3_600_000);
  });
  it("allows 60 s plus half a second per kept second for a preview, to 15 minutes", () => {
    expect(encodeTimeoutMs(90_000, true)).toBe(60_000 + 45_000);
    expect(encodeTimeoutMs(100_000_000, true)).toBe(900_000);
  });
});

describe("USED_OPTIONS", () => {
  it("lists what the builders use", () => {
    const text = [args(recipeFor()).join(" "), filterGraph(recipeFor()).graph, filterGraph(recipeFor({ fit: "crop" })).graph, filterGraph(recipeFor({ fit: "pad_color" })).graph, filterGraph(recipeFor({}, { maxFrameRate: 24 }, { ...source, facts: { ...facts, frameRate: 60 } })).graph].join(" ");
    for (const filter of Object.keys(USED_OPTIONS.filters)) expect(text).toContain(filter);
    expect(text).toContain("libx264");
    expect(text).toContain("+faststart");
  });
});
