import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// One date format (design system §4): every instant shown to a person goes through `formatLocal`
// / `LocalTime` in the project's zone, so "Mon, Oct 12, 9:00 AM EDT" is the only shape in the app.
// Hand-rolled formatters drifted into five different looks before this test existed.

const ROOT = process.cwd();
const SRC = "src";

/** Formatters that render a date for a person. `toLocaleString` on a number is fine and not matched. */
const BANNED = [
  { pattern: /\.toUTCString\(\)/, why: "renders UTC, not the project's zone" },
  { pattern: /\.toDateString\(\)/, why: "a third date shape" },
  { pattern: /\.toLocaleDateString\(/, why: "uses the viewer's locale and zone" },
  { pattern: /\.toLocaleTimeString\(/, why: "uses the viewer's locale and zone" },
  { pattern: /\.toISOString\(\)\.slice\(/, why: "shows a raw ISO date" },
  { pattern: /new Intl\.DateTimeFormat\(/, why: "a hand-rolled date format" },
  { pattern: /\bIntl\.DateTimeFormat\(/, why: "a hand-rolled date format" },
];

/**
 * Files that legitimately touch `Intl.DateTimeFormat` for something other than showing a date:
 * zone detection, the zone picker's offset labels, a date key, and zone validation.
 */
const ALLOWED = new Set([
  "src/lib/time/format.ts", // the one formatter
  "src/app/p/new/new-project-form.tsx", // reads the browser's own zone
  "src/components/email/BrowserTimeZone.tsx", // reads the browser's own zone to pre-fill the picker
  "src/components/ui/TimeZoneField.tsx", // "GMT+1" labels in the zone picker
  "src/lib/compose/first-post.ts", // a yyyy-mm-dd key, never displayed
  "src/lib/validation/timezone.ts", // throws on an unknown zone
  "src/providers/pinterest/window.ts", // yyyy-mm-dd query params Pinterest's analytics API requires, never displayed
  "src/server/dal/insights-read.ts", // a UTC day inside a grouping key, never displayed
  "src/server/services/insights/fold.ts", // the UTC day the rollup buckets by, never displayed
]);

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) return files(rel);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [rel] : [];
  });
}

describe("one date format", () => {
  it("no file formats a date by hand", () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const posix = file.replaceAll("\\", "/");
      if (ALLOWED.has(posix)) continue;
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        for (const { pattern, why } of BANNED) {
          if (pattern.test(line)) offenders.push(`${posix}:${i + 1} ${pattern.source} — ${why}`);
        }
      }
    }
    expect(offenders, "use formatLocal/LocalTime, or add a reason to ALLOWED").toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const present = new Set(files(SRC).map((f) => f.replaceAll("\\", "/")));
    expect([...ALLOWED].filter((f) => !present.has(f))).toEqual([]);
  });
});
