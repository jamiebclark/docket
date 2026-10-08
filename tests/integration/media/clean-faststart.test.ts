import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { indexAtFront } from "../../../src/server/video/boxes";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { probeFile } from "../../../src/server/video/probe";
import { processVideoFile, type VideoLimits } from "../../../src/server/video/process";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { createVideoFixtures, type VideoFixtures } from "../../helpers/video-fixtures";

const suite = requireFfmpeg();
const LIMITS: VideoLimits = { maxBytes: 50_000_000, maxSeconds: 900, maxSide: 4096 };
const signal = new AbortController().signal;

suite("a new upload is stored with its index at the front (D18, real ffmpeg)", () => {
  let fx: VideoFixtures;
  const dirs: string[] = [];
  beforeAll(() => {
    markWorkerProcess();
    fx = createVideoFixtures();
  });
  afterAll(() => {
    fx?.cleanup();
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  it("moves the index to the front of a file that had it at the end, without re-encoding", async () => {
    expect(await indexAtFront(fx.indexAtEnd)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "docket-faststart-"));
    dirs.push(dir);
    const r = await processVideoFile(fx.indexAtEnd, dir, LIMITS, signal);
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    expect(await indexAtFront(r.cleanPath)).toBe(true);
    expect(r.facts.indexAtFront).toBe(true);
    // Streams were copied: same codecs, size and frame rate as the source.
    const before = await probeFile(fx.indexAtEnd, signal);
    const after = await probeFile(r.cleanPath, signal);
    if ("error" in before || "error" in after) throw new Error("probe failed");
    expect(after).toMatchObject({ videoCodec: before.videoCodec, audioCodec: before.audioCodec, width: before.width, height: before.height, frameRate: before.frameRate });
  });

  it("records the bitrates, sample rate and channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docket-faststart-"));
    dirs.push(dir);
    const r = await processVideoFile(fx.landscape, dir, LIMITS, signal);
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    expect(r.facts.videoBitrate).toBeGreaterThan(0);
    expect(r.facts.audioSampleRate).toBeGreaterThan(0);
    expect(r.facts.audioChannels).toBeGreaterThan(0);
    const silent = await processVideoFile(fx.silent, dir, LIMITS, signal);
    if (!silent.ok) throw new Error(silent.reason);
    expect(silent.facts).toMatchObject({ audioBitrate: null, audioSampleRate: null, audioChannels: null });
  });
});
