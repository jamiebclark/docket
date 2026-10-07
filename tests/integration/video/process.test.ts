import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { probeFile } from "../../../src/server/video/probe";
import { processVideoFile, type VideoLimits } from "../../../src/server/video/process";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { createVideoFixtures, LOCATION_TAG, probeJson, type VideoFixtures } from "../../helpers/video-fixtures";

const suite = requireFfmpeg();
const LIMITS: VideoLimits = { maxBytes: 50_000_000, maxSeconds: 900, maxSide: 4096 };
const signal = new AbortController().signal;

suite("processVideoFile (real ffmpeg)", () => {
  let fx: VideoFixtures;
  const dirs: string[] = [];
  const work = () => {
    const d = mkdtempSync(join(tmpdir(), "docket-vtest-"));
    dirs.push(d);
    return d;
  };
  beforeAll(() => {
    markWorkerProcess();
    fx = createVideoFixtures();
  });
  afterAll(() => {
    fx?.cleanup();
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  async function ok(path: string, limits = LIMITS) {
    const r = await processVideoFile(path, work(), limits, signal);
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    return r;
  }

  it("reads facts of landscape, portrait, silent and MOV clips", async () => {
    const landscape = await ok(fx.landscape);
    expect(landscape.facts).toMatchObject({ container: "mp4", width: 320, height: 180, videoCodec: "h264", audioCodec: "aac" });
    expect(Math.abs(landscape.facts.durationSeconds - 2)).toBeLessThan(0.1);
    expect(landscape.thumbnail.width).toBeGreaterThan(0);
    expect((await ok(fx.portrait)).facts).toMatchObject({ width: 180, height: 320 });
    expect((await ok(fx.silent)).facts.audioCodec).toBeNull();
    expect((await ok(fx.mov)).facts.container).toBe("mov");
  });

  it("applies rotation: displayed 180×320 and a portrait poster", async () => {
    const r = await ok(fx.rotated);
    expect(r.facts).toMatchObject({ width: 180, height: 320 });
    const meta = await sharp(r.thumbnail.body).metadata();
    expect(meta.height!).toBeGreaterThan(meta.width!);
    const probed = await probeFile(r.cleanPath, signal);
    expect(probed).toMatchObject({ width: 180, height: 320 });
  });

  it("removes the location tag from the clean bytes", async () => {
    const r = await ok(fx.located);
    // Compare what ffprobe reads, not raw bytes: a plain .mp4 stores the location as a binary `loci` box.
    expect(JSON.stringify(probeJson(fx.located))).toContain("48.8584");
    expect(JSON.stringify(probeJson(r.cleanPath))).not.toContain("48.8584");
    expect(LOCATION_TAG).toContain("48.8584");
    expect(JSON.stringify(await probeFile(r.cleanPath, signal))).not.toContain("location");
  });

  // An `.m4a` carries the `M4A ` brand, so the sniff turns it away before ffprobe ever runs.
  it("refuses corrupt and audio-only files with a reason", async () => {
    expect(await processVideoFile(fx.corrupt, work(), LIMITS, signal)).toMatchObject({ ok: false, reason: "Docket could not read this video." });
    expect(await processVideoFile(fx.audioOnly, work(), LIMITS, signal)).toMatchObject({ ok: false, reason: "This is not an MP4 or MOV video." });
  });

  it("names the limit when a video is over it", async () => {
    const dur = await processVideoFile(fx.landscape, work(), { ...LIMITS, maxSeconds: 1 }, signal);
    expect(dur).toMatchObject({ ok: false });
    expect(!dur.ok && dur.reason).toMatch(/^Videos can be up to 1 second; this one is 2 seconds\.$/);
    const side = await processVideoFile(fx.landscape, work(), { ...LIMITS, maxSide: 200 }, signal);
    expect(!side.ok && side.reason).toBe("Videos can be up to 200 px on a side; this one is 320 px.");
    const size = await processVideoFile(fx.landscape, work(), { ...LIMITS, maxBytes: 1000 }, signal);
    expect(!size.ok && size.reason).toMatch(/^Videos can be up to /);
  });

  it("leaves no .tmp file behind and never renames a failed clean", async () => {
    const dir = work();
    const r = await processVideoFile(fx.corrupt, dir, LIMITS, signal);
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, "clean.mp4"))).toBe(false);
    expect(existsSync(join(dir, "clean.mp4.tmp"))).toBe(false);
  });
});
