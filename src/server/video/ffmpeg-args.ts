import type { VideoRecipe } from "../../providers/video-plan";

/**
 * Pure builders for the ffmpeg arguments of an adapted video (FR-037). Every number comes from the frozen recipe, so the
 * worker cannot disagree with the plan. Nothing here runs a tool; `tests/integration/video/ffmpeg-options.test.ts` checks
 * the spellings below against the installed ffmpeg's own help.
 *
 * Never emits `-fs`: it truncates the file instead of fitting it (research/ffmpeg.md); size is fitted by bitrate.
 */

/**
 * Option and flag names this file relies on, by the help text that must list them (`ffmpeg -h encoder=…`,
 * `-h filter=…`, `-h muxer=…`). Generic options such as `-g`, `-maxrate` and `-bufsize` are not listed there.
 */
export const USED_OPTIONS: {
  encoders: Record<"libx264" | "aac", string[]>;
  filters: Record<string, string[]>;
  muxers: Record<"mp4" | "mov", string[]>;
} = {
  encoders: { libx264: ["preset", "profile", "crf"], aac: [] },
  filters: {
    crop: ["w", "h", "x", "y"],
    pad: ["width", "height", "x", "y", "color"],
    scale: ["w", "h"],
    boxblur: ["luma_radius", "luma_power"],
    overlay: ["x", "y"],
    fps: ["fps"],
    split: [],
    setsar: ["sar"],
    format: ["pix_fmts"],
  },
  muxers: { mp4: ["movflags", "faststart"], mov: ["movflags", "faststart"] },
};

const COMMON = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
const MIN_SIDE = 2;

const seconds = (ms: number) => (ms / 1000).toFixed(3);
const even = (n: number) => Math.max(MIN_SIDE, Math.floor(n / 2) * 2);
const hex = (fill: string) => (/^#[0-9a-fA-F]{6}$/.test(fill) ? `0x${fill.slice(1).toLowerCase()}` : "0x000000");

/** The video filter graph for a recipe. `complex` means it needs `-filter_complex` (labelled output `[v]`). */
export function filterGraph(recipe: VideoRecipe): { graph: string; complex: boolean } {
  const fps = recipe.frameRate !== null ? [`fps=${recipe.frameRate}`] : [];
  const tail = ["setsar=1", "format=yuv420p"];
  const f = recipe.frame;
  if (f.kind === "pad" && f.fill === "blur") {
    const qw = even(f.canvasW / 4);
    const qh = even(f.canvasH / 4);
    // Cover the quarter-size canvas at the source's aspect, then crop to it.
    const wide = f.frameW / f.frameH > qw / qh;
    const bw = wide ? even((qh * f.frameW) / f.frameH) : qw;
    const bh = wide ? qh : even((qw * f.frameH) / f.frameW);
    const radius = Math.max(1, Math.min(10, Math.floor(Math.min(qw, qh) / 4)));
    const head = ["[0:v]", ...fps.map((s) => `${s},`), "split=2[bg][fg]"].join("");
    const graph = [
      head,
      `[bg]scale=${bw}:${bh},crop=${qw}:${qh},boxblur=luma_radius=${radius}:luma_power=2,scale=${f.canvasW}:${f.canvasH}[b]`,
      `[fg]scale=${f.frameW}:${f.frameH}[f]`,
      `[b][f]overlay=${f.x}:${f.y},${tail.join(",")}[v]`,
    ].join(";");
    return { graph, complex: true };
  }
  const chain = [...fps];
  if (f.kind === "crop") {
    chain.push(`crop=${f.w}:${f.h}:${f.x}:${f.y}`);
    if (f.w !== recipe.width || f.h !== recipe.height) chain.push(`scale=${recipe.width}:${recipe.height}`);
  } else if (f.kind === "pad") {
    chain.push(`scale=${f.frameW}:${f.frameH}`, `pad=${f.canvasW}:${f.canvasH}:${f.x}:${f.y}:color=${hex(f.fill)}`);
  } else {
    // A no-op when the size is unchanged; the recipe's size already has odd sides made even.
    chain.push(`scale=${recipe.width}:${recipe.height}`);
  }
  chain.push(...tail);
  return { graph: chain.join(","), complex: false };
}

/** `ffmpeg` arguments to build a full version or a preview from the stored original. */
export function encodeArgs(src: string, dst: string, recipe: VideoRecipe, rate: { videoBitrate: number | null }, opts: { preview: boolean }): string[] {
  const { graph, complex } = filterGraph(recipe);
  const cap = rate.videoBitrate ?? recipe.video.maxBitrate;
  const gop = Math.max(1, Math.ceil((recipe.frameRate ?? 30) * 2));
  return [
    ...COMMON,
    ...(recipe.startMs > 0 ? ["-ss", seconds(recipe.startMs)] : []),
    "-i", src,
    "-t", seconds(recipe.keptMs),
    ...(complex ? ["-filter_complex", graph, "-map", "[v]"] : ["-vf", graph, "-map", "0:v:0"]),
    ...(recipe.audio ? ["-map", "0:a:0?"] : []),
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-preset", opts.preview ? "ultrafast" : "veryfast",
    "-crf", opts.preview ? "30" : "23",
    "-g", String(gop),
    ...(cap !== null ? ["-maxrate", String(Math.floor(cap)), "-bufsize", String(Math.floor(cap) * 2)] : []),
    ...(recipe.audio
      ? ["-c:a", "aac", "-b:a", String(recipe.audio.bitrate), "-ar", String(recipe.audio.sampleRate), "-ac", String(recipe.audio.channels)]
      : ["-an"]),
    "-movflags", "+faststart", "-f", "mp4", dst,
  ];
}

/**
 * Entry 2's remux with `-c copy`, plus `+faststart`. Metadata is kept: the source is the already-cleaned original.
 * `mode` is clean's rotation handling: `display` re-applies a rotation with `-display_rotation`, `tag` with a `rotate` tag.
 */
export function rewrapArgs(src: string, dst: string, recipe: VideoRecipe, rotation: 0 | 90 | 180 | 270, mode: "none" | "display" | "tag"): string[] {
  return [
    ...COMMON,
    ...(mode === "display" ? ["-display_rotation:v:0", String(rotation)] : []),
    "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
    ...(mode === "tag" ? ["-metadata:s:v:0", `rotate=${(360 - rotation) % 360}`] : []),
    "-movflags", "+faststart", "-f", recipe.container, dst,
  ];
}

/** Full: min(60 min, 120 s + 2 s per kept second). Preview: min(15 min, 60 s + 0.5 s per kept second). */
export function encodeTimeoutMs(keptMs: number, preview: boolean): number {
  const kept = Math.max(0, keptMs);
  return preview ? Math.min(15 * 60_000, 60_000 + Math.ceil(kept / 2)) : Math.min(60 * 60_000, 120_000 + kept * 2);
}
