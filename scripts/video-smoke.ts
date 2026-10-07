// Smoke test for the image's own ffmpeg (research P22). Run inside the built image:
//   docker run --rm --entrypoint node docket:ci scripts/video-smoke.mjs
// It generates clips with lavfi, runs processVideoFile (no database, no storage) and exits non-zero on any failed
// assertion. Never runs at import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFixtures, probeJson } from "../tests/helpers/video-fixtures";
import { markWorkerProcess } from "../src/server/video/guard";
import { processVideoFile } from "../src/server/video/process";

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

async function main() {
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
