import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { providerPublishLimits } from "../../../src/providers/limits";
import { providers } from "../../../src/providers/registry";
import type { SocialProvider } from "../../../src/providers/types";
import { generatedTitles, type Suite } from "../../helpers/limit-rows";

const root = resolve(__dirname, "../../..");
const ENFORCEMENT = "tests/integration/limits/enforcement.test.ts";

/** Which generated suites may prove a row, by its "Enforced in" cell. */
function suitesFor(enforcedIn: string): Suite[] | undefined {
  if (enforcedIn === "validateResolvedContent") return ["core", "text", "video"];
  if (enforcedIn === "media planner") return ["planner"];
  if (/^(engine deferral|account limit)/.test(enforcedIn)) return ["limits"];
  return undefined;
}

/** The string-literal titles of `describe(`, `it(` and `test(` calls (template titles are generated, not literal). */
function literalTitles(path: string): string[] {
  const src = readFileSync(path, "utf8");
  return [...src.matchAll(/\b(?:describe|it|test)(?:\.\w+)*(?:\([^)]*\))?\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
}
const doc = readFileSync(resolve(root, "docs/limits.md"), "utf8");

interface Row {
  category: string;
  value: string;
  source: string;
  enforcedIn: string;
  test: string;
}

/** `## Heading` → table rows. The heading is matched to a provider by display name. */
function tables(): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  let current: Row[] | null = null;
  for (const line of doc.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      current = [];
      out.set(heading[1]!.trim(), current);
      continue;
    }
    if (!current || !line.startsWith("|") || /^\|[-| ]+\|$/.test(line) || line.startsWith("| Category")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 6) throw new Error(`Malformed limits row: ${line}`);
    current.push({ category: cells[0]!, value: cells[1]!, source: cells[3]!, enforcedIn: cells[4]!, test: cells[5]! });
  }
  return out;
}

/** What each provider declares, as category → values (the doc must list exactly these). */
function declared(provider: SocialProvider): Map<string, string[]> {
  const { text, media, textOnlyAllowed } = provider.capabilities;
  const m = new Map<string, string[]>();
  m.set("text length", [String(text.maxLength)]);
  if (text.maxHashtags !== undefined) m.set("hashtags", [String(text.maxHashtags)]);
  if (text.maxMentions !== undefined) m.set("mentions", [String(text.maxMentions)]);
  m.set("images", [String(media.maxImages)]);
  m.set("bytes per file", [String(media.maxBytesPerFile)]);
  m.set("formats", [media.allowedMimeTypes.join(", ")]);
  const optional: [string, number | undefined][] = [
    ["min width", media.minWidth],
    ["max width", media.maxWidth],
    ["min height", media.minHeight],
    ["max height", media.maxHeight],
    ["min aspect", media.minAspectRatio],
    ["max aspect", media.maxAspectRatio],
    ["alt text length", media.maxAltTextLength],
  ];
  for (const [k, v] of optional) if (v !== undefined) m.set(k, [String(v)]);
  const { byPostType, ...video } = provider.capabilities.video;
  m.set("videos", [String(video.maxVideos)]);
  if (video.maxVideos > 0) {
    const yesNo = (b: boolean) => (b ? "yes" : "no");
    const listed = (v: Partial<typeof video>, prefix: string): [string, string | undefined][] => [
      ["videos", prefix ? v.maxVideos?.toString() : undefined],
      ["video with images", v.withImages === undefined ? undefined : yesNo(v.withImages)],
      ["video containers", v.containers?.join(", ")],
      ["video codecs", v.videoCodecs?.join(", ")],
      ["audio codecs", v.audioCodecs?.join(", ")],
      ["silent video", v.silentAllowed === undefined ? undefined : yesNo(v.silentAllowed)],
      ["video bytes", v.maxBytes?.toString()],
      ["min duration", v.minDurationSeconds?.toString()],
      ["max duration", v.maxDurationSeconds?.toString()],
      ["video min width", v.minWidth?.toString()],
      ["video max width", v.maxWidth?.toString()],
      ["video min height", v.minHeight?.toString()],
      ["video max height", v.maxHeight?.toString()],
      ["video min aspect", v.minAspectRatio?.toString()],
      ["video max aspect", v.maxAspectRatio?.toString()],
      ["min frame rate", v.minFrameRate?.toString()],
      ["max frame rate", v.maxFrameRate?.toString()],
    ];
    for (const [k, v] of listed(video, "")) if (v !== undefined && k !== "videos") m.set(k, [v]);
    // One prefixed row per field a post type overrides: `carousel videos`, `carousel video min aspect` …
    for (const [type, over] of Object.entries(byPostType ?? {})) {
      const { notes: _notes, ...limits } = over;
      for (const [k, v] of listed(limits, type)) if (v !== undefined) m.set(`${type} ${k}`, [v]);
    }
  }
  if (provider.creationAllowance) {
    const a = provider.creationAllowance;
    m.set("creation allowance", [`${a.count} / ${a.windowSeconds} s`]);
  }
  m.set("media required", [media.required ? "yes" : "no"]);
  m.set("text only", [textOnlyAllowed ? "yes" : "no"]);
  const limits = providerPublishLimits(provider).map((l) => `${l.count} / ${l.windowSeconds} s`);
  m.set("publish limit", limits.length ? limits : ["none"]);
  return m;
}

const all = tables();
const sectionFor = (p: SocialProvider) => [...all.keys()].find((k) => k.toLowerCase().startsWith(p.displayName.split(" ")[0]!.toLowerCase()));

describe("docs/limits.md matches the registered providers (D13)", () => {
  for (const provider of providers) {
    describe(provider.key, () => {
      const heading = sectionFor(provider);
      const rows = heading ? all.get(heading)! : [];

      it("has a table", () => {
        expect(heading, `no table for ${provider.key}`).toBeDefined();
      });

      it("lists every declared capability and limit with its declared value", () => {
        for (const [category, values] of declared(provider)) {
          const listed = rows.filter((r) => r.category === category).map((r) => r.value);
          expect(listed.sort(), `${provider.key} ${category}`).toEqual([...values].sort());
        }
      });

      it("has no row for a limit the provider does not declare", () => {
        const known = declared(provider);
        for (const r of rows) {
          if (r.category.startsWith("note:")) continue;
          expect(known.has(r.category), `${provider.key}: unexpected row "${r.category}"`).toBe(true);
        }
      });

      it("names a source, an enforcement point and an existing proving test on every row; none is unenforced", () => {
        for (const r of rows) {
          expect(r.source, r.category).not.toBe("");
          expect(r.enforcedIn, r.category).not.toBe("");
          expect(`${r.enforcedIn} ${r.test}`.toLowerCase(), r.category).not.toContain("unenforced");
          const file = /`([^`]+\.test\.ts)`/.exec(r.test)?.[1];
          expect(file, `${provider.key} ${r.category}: no test file named`).toBeDefined();
          const path = resolve(root, file!);
          expect(existsSync(path), `${file} does not exist`).toBe(true);
        }
      });

      it("cites, on every row, a test that breaks exactly that limit in the suite for its enforcement point", () => {
        const generated = generatedTitles(provider);
        for (const r of rows) {
          const where = `${provider.key} ${r.category}`;
          const file = /`([^`]+\.test\.ts)`/.exec(r.test)?.[1];
          const fragment = /"([^"]+)"/.exec(r.test)?.[1];
          expect(fragment, `${where}: no quoted test name`).toBeDefined();
          if (file === ENFORCEMENT && !r.category.startsWith("note:")) {
            // A generated row: named after this provider and this row's category (and value, for publish limits).
            const expected = r.category === "publish limit" ? `${provider.key}: publish limit ${r.value}` : `${provider.key}: ${r.category}`;
            expect(fragment, where).toBe(expected);
            const suites = generated.filter((g) => g.title === fragment).map((g) => g.suite);
            expect(suites.length, `${where}: the enforcement test generates no test named "${fragment}"`).toBeGreaterThan(0);
            const wanted = suitesFor(r.enforcedIn);
            expect(wanted, `${where}: unknown enforcement point "${r.enforcedIn}"`).toBeDefined();
            expect(suites.some((s) => wanted!.includes(s)), `${where}: "${fragment}" is not in a ${wanted!.join("/")} suite`).toBe(true);
          } else {
            expect(literalTitles(resolve(root, file!)).some((t) => t.includes(fragment!)), `${file} has no test or describe titled "${fragment}"`).toBe(true);
          }
        }
      });

      it("marks only Facebook text length and images, and Instagram's carousel video aspect, UNVERIFIED", () => {
        const flagged = rows.filter((r) => r.source.includes("UNVERIFIED")).map((r) => r.category).sort();
        const expected =
          provider.key === "facebook"
            ? ["images", "text length"]
            : provider.key === "instagram"
              ? ["carousel video max aspect", "carousel video min aspect"]
              : [];
        expect(flagged).toEqual(expected);
      });

      it("marks interim values UNVERIFIED", () => {
        for (const r of rows) {
          if (/interim/i.test(r.source)) expect(r.source, r.category).toMatch(/UNVERIFIED|test double/);
        }
      });
    });
  }
});
