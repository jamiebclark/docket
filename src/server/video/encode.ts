import { rm, stat } from "node:fs/promises";
import type { VideoRecipe } from "../../providers/video-plan";
import { encodeArgs, encodeTimeoutMs, rewrapArgs } from "./ffmpeg-args";
import { probeFile } from "./probe";
import { runTool } from "./spawn";

/** A build that cannot succeed as asked; the loop stores `reasonFor(code)` and logs the tail. */
export class BuildError extends Error {
  constructor(
    readonly code: "unreadable" | "timeout" | "too_large",
    readonly stderrTail = "",
  ) {
    super(code);
    this.name = "BuildError";
  }
}

/** P8: at most this many encodes per attempt. */
export const MAX_ENCODES = 4;
const BITRATE_RETRIES = 2;
const SHRINK = 0.75;
const SAFETY = 0.9;

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** The recipe at 0.75× size, or null when that would go under the target's minimum. */
export function shrinkRecipe(recipe: VideoRecipe): VideoRecipe | null {
  const width = even(recipe.width * SHRINK);
  const height = even(recipe.height * SHRINK);
  if (width < recipe.video.minWidth || height < recipe.video.minHeight) return null;
  const frame =
    recipe.frame.kind === "pad"
      ? (() => {
          const f = recipe.frame;
          const fw = even(f.frameW * (width / f.canvasW));
          const fh = even(f.frameH * (height / f.canvasH));
          return { ...f, canvasW: width, canvasH: height, frameW: fw, frameH: fh, x: Math.floor((width - fw) / 4) * 2, y: Math.floor((height - fh) / 4) * 2 };
        })()
      : recipe.frame;
  return { ...recipe, width, height, frame };
}

async function ffmpeg(args: string[], timeoutMs: number, signal: AbortSignal) {
  const r = await runTool("ffmpeg", args, { timeoutMs, signal });
  if (r.killed) throw new BuildError("timeout", r.stderrTail);
  if (r.code !== 0) throw new BuildError("unreadable", r.stderrTail);
}

/**
 * Builds `dst` from `src` as the recipe says. A rewrap copies the streams (re-applying a rotation as entry 2's clean step does);
 * an encode runs x264/AAC, and when the target has a byte limit, retries at a lower bitrate and then a smaller size (P8, never `-fs`).
 * The returned recipe is the one that produced the file, so the caller reads it back against what was really built.
 * Throws `BuildError`, `ToolMissingError` or the abort of `signal`.
 */
export async function buildFile(
  src: string,
  dst: string,
  recipe: VideoRecipe,
  opts: { preview: boolean; signal: AbortSignal },
): Promise<VideoRecipe> {
  const { signal } = opts;
  if (recipe.mode === "rewrap") {
    const probe = await probeFile(src, signal);
    if ("error" in probe) throw new BuildError("unreadable");
    const modes: ("none" | "display" | "tag")[] = probe.rotation === 0 ? ["none"] : ["display", "tag"];
    let last: BuildError | null = null;
    for (const mode of modes) {
      await rm(dst, { force: true });
      try {
        await ffmpeg(rewrapArgs(src, dst, recipe, probe.rotation, mode), encodeTimeoutMs(recipe.keptMs, false), signal);
        const check = await probeFile(dst, signal);
        if (!("error" in check) && check.width === probe.width && check.height === probe.height) return recipe;
        last = new BuildError("unreadable");
      } catch (e) {
        if (!(e instanceof BuildError) || e.code === "timeout") throw e;
        last = e;
      }
    }
    throw last ?? new BuildError("unreadable");
  }

  let current = recipe;
  let cap: number | null = null;
  let retries = 0;
  let shrunk = false;
  for (let encodes = 1; ; encodes++) {
    await rm(dst, { force: true });
    await ffmpeg(encodeArgs(src, dst, current, { videoBitrate: cap }, { preview: opts.preview }), encodeTimeoutMs(current.keptMs, opts.preview), signal);
    const maxBytes = current.video.maxBytes;
    if (opts.preview || maxBytes === null) return current;
    const bytes = (await stat(dst)).size;
    if (bytes <= maxBytes) return current;
    if (encodes >= MAX_ENCODES) throw new BuildError("too_large");
    if (retries < BITRATE_RETRIES) {
      retries++;
      const seconds = Math.max(0.001, current.keptMs / 1000);
      const was = cap ?? current.video.maxBitrate ?? Math.floor((bytes * 8) / seconds);
      cap = Math.max(1, Math.floor(was * (maxBytes / bytes) * SAFETY));
    } else if (!shrunk) {
      const smaller = shrinkRecipe(current);
      if (!smaller) throw new BuildError("too_large");
      shrunk = true;
      current = smaller;
    } else {
      throw new BuildError("too_large");
    }
  }
}

/** The plain sentences stored in `video_versions.error` (contracts/video-worker.md). `limit` is the "300 MB for Instagram" tail. */
export function reasonFor(code: BuildError["code"], tooLarge = "The video could not be made small enough."): string {
  if (code === "timeout") return "Adapting the video took too long.";
  if (code === "too_large") return tooLarge;
  return "Docket could not read the video.";
}
