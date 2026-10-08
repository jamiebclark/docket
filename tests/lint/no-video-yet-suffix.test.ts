import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FR-032: the formatter crops, trims and converts, so no message may still say Docket does not.
// docs/decisions.md is the historical record of what earlier entries said, so it is the one file left alone.
const ROOT = process.cwd();
const REMOVED = [/does not crop, trim or convert video yet/i, /does not crop video yet/i];
const HISTORY = join(ROOT, "docs", "decisions.md");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|md|mdx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the removed 'Docket does not crop, trim or convert video yet.' suffix", () => {
  it("appears nowhere under src/ or docs/", () => {
    const found = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "docs"))]
      .filter((f) => f !== HISTORY)
      .filter((f) => REMOVED.some((re) => re.test(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f));
    expect(found).toEqual([]);
  });
});
