import { spawnSync } from "node:child_process";
import { describe } from "vitest";

/** True when both `ffmpeg` and `ffprobe` run. */
export function hasFfmpeg(): boolean {
  return ["ffmpeg", "ffprobe"].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
}

/**
 * Gate for suites that run real ffmpeg. Locally a missing ffmpeg skips the suite; in CI (`CI` set) it throws,
 * so a runner without ffmpeg cannot turn the suite into a silent pass.
 */
export function requireFfmpeg(): typeof describe {
  if (hasFfmpeg()) return describe;
  if (process.env.CI) throw new Error("ffmpeg is required in CI");
  return describe.skip as unknown as typeof describe;
}
