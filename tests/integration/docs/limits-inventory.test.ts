import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { providerPublishLimits } from "../../../src/providers/limits";
import { providers } from "../../../src/providers/registry";
import type { SocialProvider } from "../../../src/providers/types";

const root = resolve(__dirname, "../../..");
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
          const fragment = /"([^"]+)"/.exec(r.test)?.[1];
          if (fragment) expect(readFileSync(path, "utf8"), `${file} has no title containing "${fragment}"`).toContain(fragment);
        }
      });

      it("marks interim values UNVERIFIED", () => {
        for (const r of rows) {
          if (/interim/i.test(r.source)) expect(r.source, r.category).toMatch(/UNVERIFIED|test double/);
        }
      });
    });
  }
});
