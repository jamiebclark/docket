import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertEditFits, DEFAULT_VIDEO_EDIT, type VideoEdit, VideoEditError } from "../../../src/lib/video/edit";
import type { VideoCapabilities, VideoFacts } from "../../../src/providers/types";
import { planVideo, type VideoPlan } from "../../../src/providers/video-plan";
import { buildFile } from "../../../src/server/video/encode";
import { indexAtFront } from "../../../src/server/video/boxes";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { probeFile, type ProbeResult } from "../../../src/server/video/probe";
import { readBack } from "../../../src/server/video/readback";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { createVideoFixtures, type VideoFixtures } from "../../helpers/video-fixtures";

const signal = new AbortController().signal;

/** Small, strict limits: 1 s, square, at most 200 px and 10 fps, H.264/AAC in MP4, index first. */
const STRICT: VideoCapabilities = {
  maxVideos: 1,
  containers: ["mp4"],
  videoCodecs: ["h264"],
  audioCodecs: ["aac"],
  maxDurationSeconds: 1,
  minAspectRatio: 1,
  maxAspectRatio: 1,
  maxWidth: 200,
  maxHeight: 200,
  maxFrameRate: 10,
  maxVideoBitrate: 1_000_000,
  indexAtFront: true,
  recommendedAspectRatio: 1,
};
/** Accepts anything about the picture; wants MP4 with the index first. */
const WRAP_ONLY: VideoCapabilities = { maxVideos: 1, containers: ["mp4"], videoCodecs: ["h264"], audioCodecs: ["aac"], indexAtFront: true };

const plan = (
  p: ProbeResult,
  container: "mp4" | "mov",
  front: boolean | null,
  limits: VideoCapabilities,
  bytes = 100_000,
  edit: VideoEdit = DEFAULT_VIDEO_EDIT,
): VideoPlan => {
  const facts: VideoFacts = {
    container,
    durationSeconds: p.durationSeconds,
    frameRate: p.frameRate,
    videoCodec: p.videoCodec,
    audioCodec: p.audioCodec,
    videoBitrate: p.videoBitrate,
    audioBitrate: p.audioBitrate,
    audioSampleRate: p.audioSampleRate,
    audioChannels: p.audioChannels,
    indexAtFront: front,
    factsVersion: 2,
  };
  return planVideo({ width: p.width, height: p.height, bytes, facts }, limits, edit, { index: 0, platform: "Test" });
};

requireFfmpeg()("the formatter builds what the plan says", () => {
  let fx: VideoFixtures;
  beforeAll(() => {
    markWorkerProcess();
    fx = createVideoFixtures();
  });
  afterAll(() => fx?.cleanup());

  async function build(path: string, container: "mp4" | "mov", limits: VideoCapabilities, name: string, edit: VideoEdit = DEFAULT_VIDEO_EDIT) {
    const src = await probeFile(path, signal);
    if ("error" in src) throw new Error("fixture unreadable");
    const front = await indexAtFront(path);
    const p = plan(src, container, front, limits, 100_000, edit);
    if (p.kind !== "derive") throw new Error(`expected derive, got ${p.kind}`);
    const out = join(fx.dir, `out-${name}.mp4`);
    const recipe = await buildFile(path, out, p.recipe, { preview: false, signal });
    const read = await readBack(
      out,
      recipe,
      {
        preview: false,
        source: { durationMs: Math.round(src.durationSeconds * 1000), width: src.width, height: src.height, videoCodec: src.videoCodec, audioCodec: src.audioCodec },
      },
      signal,
    );
    const probed = await probeFile(out, signal);
    if ("error" in probed) throw new Error("output unreadable");
    return { p, src, probed, read, out };
  }

  const reframed: [string, () => string, boolean][] = [
    ["landscape", () => fx.landscape, true],
    ["portrait", () => fx.portrait, true],
    ["square", () => fx.square, true],
    ["silent", () => fx.silent, false],
    ["MOV", () => fx.mov, true],
    ["60 fps", () => fx.highFps, true],
    ["index at end", () => fx.indexAtEnd, true],
    ["rotated", () => fx.rotated, true],
  ];
  it.each(reframed)("%s becomes a 1 s square H.264 MP4 within the limits", async (name, path, hasAudio) => {
    const { probed, read, out } = await build(path(), name === "MOV" ? "mov" : "mp4", STRICT, name.replace(/\W/g, ""));
    expect(read.ok).toBe(true);
    expect(probed.width).toBe(probed.height);
    expect(probed.width).toBeLessThanOrEqual(200);
    expect(Math.abs(probed.durationSeconds - 1)).toBeLessThanOrEqual(0.1);
    expect(probed.frameRate ?? 0).toBeLessThanOrEqual(10.5);
    expect(probed.videoCodec).toBe("h264");
    expect(probed.audioCodec).toBe(hasAudio ? "aac" : null);
    expect(probed.formatNames).toContain("mp4");
    expect(await indexAtFront(out)).toBe(true);
  });

  it.each([
    ["MOV", () => fx.mov, "mov" as const],
    ["index at end", () => fx.indexAtEnd, "mp4" as const],
  ])("%s is rewrapped: same streams, same picture, no re-encode", async (name, path, container) => {
    const { p, src, probed, read, out } = await build(path(), container, WRAP_ONLY, `wrap-${name.replace(/\W/g, "")}`);
    expect(p.mode).toBe("rewrap");
    expect(read.ok).toBe(true);
    expect(probed).toMatchObject({ width: src.width, height: src.height, videoCodec: src.videoCodec, audioCodec: src.audioCodec });
    expect(Math.abs(probed.durationSeconds - src.durationSeconds)).toBeLessThanOrEqual(0.1);
    expect(probed.formatNames).toContain("mp4");
    expect(await indexAtFront(out)).toBe(true);
  });

  describe("trim", () => {
    // The landscape fixture is 2 s; the target accepts any picture and any length unless a case says otherwise.
    const ANY: VideoCapabilities = { ...WRAP_ONLY, indexAtFront: false };
    const within = (probed: ProbeResult, seconds: number) => expect(Math.abs(probed.durationSeconds - seconds)).toBeLessThanOrEqual(0.1);

    it("a start alone keeps the rest of the video", async () => {
      const { p, probed, read } = await build(fx.landscape, "mp4", ANY, "trim-start", { ...DEFAULT_VIDEO_EDIT, trimStartMs: 1000 });
      expect(p.steps).toContain("cut");
      expect(read.ok).toBe(true);
      within(probed, 1);
    });

    it("a start and an end keep the part between them", async () => {
      const { read, probed } = await build(fx.landscape, "mp4", ANY, "trim-both", { ...DEFAULT_VIDEO_EDIT, trimStartMs: 500, trimEndMs: 1500 });
      expect(read.ok).toBe(true);
      within(probed, 1);
    });

    it("is cut at the target's maximum, with a note", async () => {
      const { p, read, probed } = await build(fx.landscape, "mp4", { ...ANY, maxDurationSeconds: 1 }, "trim-max");
      expect(p.notes.map((n) => n.code)).toContain("video_will_cut");
      expect(read.ok).toBe(true);
      within(probed, 1);
    });

    it("a cut at the maximum of a 29.97 fps video ends strictly inside it (G15)", async () => {
      const ntsc = join(fx.dir, "ntsc.mp4");
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30000/1001:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-an", ntsc],
        { stdio: "ignore" },
      );
      const { read, probed } = await build(ntsc, "mp4", { ...ANY, maxDurationSeconds: 1 }, "trim-ntsc");
      expect(read.ok).toBe(true);
      expect(probed.durationSeconds).toBeLessThanOrEqual(1);
    });

    it("a trim equal to the whole video is as is, with no version", async () => {
      const src = await probeFile(fx.landscape, signal);
      if ("error" in src) throw new Error("fixture unreadable");
      const whole = Math.round(src.durationSeconds * 1000);
      expect(plan(src, "mp4", true, ANY, 100_000, { ...DEFAULT_VIDEO_EDIT, trimStartMs: 0, trimEndMs: whole }).kind).toBe("original");
    });
  });
});

describe("trim limits", () => {
  it("refuses a trim that leaves under one second", () => {
    expect(() => assertEditFits({ ...DEFAULT_VIDEO_EDIT, trimStartMs: 1500 }, 2000)).toThrow(VideoEditError);
    expect(() => assertEditFits({ ...DEFAULT_VIDEO_EDIT, trimStartMs: 0, trimEndMs: 900 }, 2000)).toThrow(VideoEditError);
  });
});
