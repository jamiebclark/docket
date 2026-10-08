import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { USED_OPTIONS } from "../../../src/server/video/ffmpeg-args";
import { requireFfmpeg } from "../../helpers/ffmpeg";

const suite = requireFfmpeg();

/** The installed ffmpeg's own help for one component (research/ffmpeg.md §6: spellings checked against the tool). */
function help(kind: "encoder" | "filter" | "muxer", name: string): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-h", `${kind}=${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return `${r.stdout}\n${r.stderr}`;
}

suite("ffmpeg-args USED_OPTIONS against the installed ffmpeg's help (P6)", () => {
  for (const [name, options] of Object.entries(USED_OPTIONS.encoders)) {
    it(`encoder ${name} exists and lists ${options.join(", ") || "no private options"}`, () => {
      const text = help("encoder", name);
      expect(text).toMatch(new RegExp(`Encoder ${name}\\b`));
      for (const option of options) expect(text).toMatch(new RegExp(`-${option}\\b`));
    });
  }
  for (const [name, options] of Object.entries(USED_OPTIONS.filters)) {
    it(`filter ${name} exists and lists ${options.join(", ") || "no options"}`, () => {
      const text = help("filter", name);
      expect(text).toMatch(new RegExp(`Filter ${name}\\b`));
      for (const option of options) expect(text).toMatch(new RegExp(`(^|\\s)${option}(\\s|$)`, "m"));
    });
  }
  for (const [name, options] of Object.entries(USED_OPTIONS.muxers)) {
    it(`muxer ${name} exists and lists ${options.join(", ")}`, () => {
      const text = help("muxer", name);
      expect(text).toMatch(new RegExp(`Muxer ${name}\\b`));
      for (const option of options) expect(text).toContain(option);
    });
  }
});
