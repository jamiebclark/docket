import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Test-time clip generators (research P23). Every generator asserts its own precondition with ffprobe. */

export const LOCATION_TAG = "+48.8584+002.2945/";

function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")} failed: ${r.stderr.slice(-800)}`);
  return r.stdout;
}

const ffmpeg = (args: string[]) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export function probeJson(path: string): {
  streams: Record<string, unknown>[];
  format: { duration?: string; tags?: Record<string, string>; format_name?: string };
} {
  return JSON.parse(run("ffprobe", ["-v", "error", "-of", "json", "-show_format", "-show_streams", path]));
}

export interface VideoFixtures {
  dir: string;
  landscape: string;
  portrait: string;
  silent: string;
  mov: string;
  rotated: string;
  located: string;
  corrupt: string;
  audioOnly: string;
  /** Generate on demand: a clip of `seconds` (default 10 minutes at low cost). */
  long(seconds?: number): string;
  /** A file of `bytes` random bytes behind a valid `ftyp` header. */
  oversize(bytes: number): string;
  cleanup(): void;
}

function lavfi(
  out: string,
  { size = "320x180", seconds = 2, audio = true, format, extra = [] }: {
    size?: string;
    seconds?: number;
    audio?: boolean;
    format?: string;
    extra?: string[];
  } = {},
) {
  ffmpeg([
    "-f", "lavfi", "-i", `testsrc=size=${size}:rate=15:duration=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    ...(audio ? ["-c:a", "aac"] : ["-an"]),
    ...extra,
    ...(format ? ["-f", format] : []),
    out,
  ]);
}

export function createVideoFixtures(): VideoFixtures {
  const dir = mkdtempSync(join(tmpdir(), "docket-video-"));
  const f = (name: string) => join(dir, name);

  const landscape = f("landscape.mp4");
  lavfi(landscape);
  const portrait = f("portrait.mp4");
  lavfi(portrait, { size: "180x320" });
  const silent = f("silent.mp4");
  lavfi(silent, { audio: false });
  const mov = f("clip.mov");
  lavfi(mov, { format: "mov" });

  // Rotation 90: stored 320x180 displays as 180x320. `-display_rotation` first, the `rotate` tag as fallback.
  const rotated = f("rotated.mp4");
  ffmpeg(["-display_rotation", "90", "-i", landscape, "-c", "copy", rotated]);
  const hasRotation = (p: string) => {
    const s = probeJson(p).streams.find((x) => x.codec_type === "video") as
      | { side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }
      | undefined;
    return Boolean(s?.side_data_list?.some((d) => d.rotation !== undefined) || s?.tags?.rotate);
  };
  if (!hasRotation(rotated)) {
    ffmpeg(["-i", landscape, "-c", "copy", "-metadata:s:v", "rotate=90", rotated]);
    if (!hasRotation(rotated)) throw new Error("fixture precondition: rotated clip carries no rotation");
  }

  // Location: the plain form first, `use_metadata_tags` if no tag was written.
  const located = f("located.mp4");
  const hasLocation = (p: string) => JSON.stringify(probeJson(p)).includes("48.8584");
  ffmpeg(["-i", landscape, "-c", "copy", "-metadata", `location=${LOCATION_TAG}`, located]);
  if (!hasLocation(located)) {
    ffmpeg(["-i", landscape, "-c", "copy", "-movflags", "use_metadata_tags", "-metadata", `location=${LOCATION_TAG}`, located]);
    if (!hasLocation(located)) throw new Error("fixture precondition: located clip carries no location tag");
  }

  const audioOnly = f("audio.m4a");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", "-f", "ipod", audioOnly]);

  // A valid `ftyp` box followed by random bytes: sniffs as MP4, fails ffprobe.
  const corrupt = f("corrupt.mp4");
  writeFileSync(corrupt, Buffer.concat([ftyp("isom"), randomBytes(4096)]));

  return {
    dir, landscape, portrait, silent, mov, rotated, located, corrupt, audioOnly,
    long(seconds = 600) {
      const out = f(`long-${seconds}.mp4`);
      lavfi(out, { seconds, audio: false });
      return out;
    },
    oversize(bytes) {
      const out = f(`oversize-${bytes}.mp4`);
      writeFileSync(out, Buffer.concat([ftyp("isom"), Buffer.alloc(bytes)]));
      return out;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** An ISO-BMFF `ftyp` box with the given major brand. */
export function ftyp(brand: string): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(24, 0);
  b.write("ftyp", 4, "ascii");
  b.write(brand.padEnd(4).slice(0, 4), 8, "ascii");
  b.write("isom", 16, "ascii");
  b.write("mp41", 20, "ascii");
  return b;
}
