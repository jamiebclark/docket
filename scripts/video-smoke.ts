// Smoke test for the image's own ffmpeg (research P22). Run inside the built image:
//   docker run --rm --entrypoint node docket:ci scripts/video-smoke.mjs
// It generates clips with lavfi, runs processVideoFile (no database, no storage) and exits non-zero on any failed
// assertion. Never runs at import.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFixtures, probeJson } from "../tests/helpers/video-fixtures";
import { markWorkerProcess } from "../src/server/video/guard";
import { processVideoFile } from "../src/server/video/process";
import { buildFile } from "../src/server/video/encode";
import { readBack } from "../src/server/video/readback";
import { DEFAULT_VIDEO_EDIT } from "../src/lib/video/edit";
import { mockProvider } from "../src/providers/mock";
import { videoLimitsFor } from "../src/providers/validation";
import { planVideo, previewRecipe } from "../src/providers/video-plan";
import type { VideoFacts } from "../src/providers/types";
import { probeFile } from "../src/server/video/probe";

const LIMITS = { maxBytes: 64 * 1024 * 1024, maxSeconds: 60, maxSide: 4096 };

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

async function run(path: string) {
  const workDir = mkdtempSync(join(tmpdir(), "docket-video-smoke-"));
  try {
    const result = await processVideoFile(path, workDir, LIMITS, new AbortController().signal);
    if (!result.ok) return { result, cleanJson: null };
    return { result, cleanJson: JSON.stringify(probeJson(result.cleanPath)) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** SC-007: a preview of a 30 s 1080x1920 clip builds and reads back within the budget (quickstart §5). */
async function formatter() {
  markWorkerProcess();
  const fixtures = createVideoFixtures();
  const workDir = mkdtempSync(join(tmpdir(), "docket-video-smoke-"));
  try {
    const signal = new AbortController().signal;
    const src = join(workDir, "source.mp4");
    const made = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-c:a", "aac", src,
      ],
      { encoding: "utf8" },
    );
    check("source fixture made", made.status === 0, made.stderr?.slice(-300));
    const probed = await probeFile(src, signal);
    if ("error" in probed) {
      check("source fixture probes", false, probed.error);
      process.exit(1);
    }
    const facts: VideoFacts = {
      container: "mp4",
      durationSeconds: probed.durationSeconds,
      frameRate: probed.frameRate,
      videoCodec: probed.videoCodec,
      audioCodec: probed.audioCodec,
      videoBitrate: probed.videoBitrate,
      audioBitrate: probed.audioBitrate,
      audioSampleRate: probed.audioSampleRate,
      audioChannels: probed.audioChannels,
      // Claimed at the end so the plan has work to do (a rewrap) whatever the source already satisfies.
      indexAtFront: false,
      factsVersion: 2,
    };
    const limits = videoLimitsFor(mockProvider.capabilities, "video");
    const plan = planVideo({ width: probed.width, height: probed.height, bytes: statSync(src).size, facts }, limits, DEFAULT_VIDEO_EDIT, {
      index: 0,
      platform: "Mock",
    });
    check("plan derives a recipe", plan.kind === "derive", plan.kind);
    if (plan.kind !== "derive") process.exit(1);
    const recipe = previewRecipe(plan.recipe, probed.frameRate);
    check("preview is at most 640 px", Math.max(recipe.width, recipe.height) <= 640, `${recipe.width}x${recipe.height}`);
    const dst = join(workDir, "preview.mp4");
    const started = Date.now();
    const built = await buildFile(src, dst, recipe, { preview: true, signal });
    const ms = Date.now() - started;
    const back = await readBack(dst, built, { preview: true }, signal);
    console.log(`SC-007 preview of 30s 1080x1920 → ${ms} ms (budget 60000 ms on two cores)`);
    check("preview reads back", back.ok, back.ok ? "" : back.mismatch);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    fixtures.cleanup();
  }
  if (failures > 0) process.exit(1);
}

async function main() {
  if (process.argv.includes("--formatter")) return formatter();
  markWorkerProcess(); // the pipeline refuses to spawn ffmpeg outside the worker
  const fixtures = createVideoFixtures();
  try {
    const landscape = await run(fixtures.landscape);
    check("landscape processes", landscape.result.ok, landscape.result.ok ? "" : landscape.result.reason);
    if (landscape.result.ok) {
      const { facts, thumbnail } = landscape.result;
      check("landscape facts", facts.width === 320 && facts.height === 180 && facts.videoCodec === "h264", `${facts.width}x${facts.height} ${facts.videoCodec}`);
      check("poster made", thumbnail.body.length > 0 && thumbnail.width > 0);
    }

    const rotated = await run(fixtures.rotated);
    check("rotated processes", rotated.result.ok, rotated.result.ok ? "" : rotated.result.reason);
    if (rotated.result.ok) {
      const { facts } = rotated.result;
      check("rotation applied to displayed size", facts.width === 180 && facts.height === 320, `${facts.width}x${facts.height}`);
    }

    const located = await run(fixtures.located);
    check("located processes", located.result.ok, located.result.ok ? "" : located.result.reason);
    if (located.cleanJson) check("location tag removed", !located.cleanJson.includes("48.8584"));
  } finally {
    fixtures.cleanup();
  }
  if (failures > 0) {
    console.log(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("video smoke ok");
}

main().catch((err) => {
  console.log(`✗ video smoke crashed — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
