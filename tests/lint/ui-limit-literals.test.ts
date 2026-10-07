import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIDEO_MAX_SIDE } from "@/lib/media/types";
import { parseEnv } from "@/server/env";
import { libraryLimits } from "@/server/media/limits";
import { listProviders } from "@/providers/registry";
import { countingRuleName } from "@/providers/text";

// SC-004: the composer, picker and library show provider limits from the server's summary, never from
// a literal of their own. A MIME string, counting-rule name or declared limit written here would drift.
const UI_FILES = [
  "src/app/p/[projectSlug]/compose/Composer.tsx",
  "src/components/compose/RequirementsSummary.tsx",
  "src/components/compose/requirements-ui.ts",
  "src/components/media/FitBadges.tsx",
  "src/components/media/fit-ui.ts",
  "src/components/media/MediaPicker.tsx",
  "src/components/media/MediaCard.tsx",
  "src/app/p/[projectSlug]/media/page.tsx",
  "src/app/p/[projectSlug]/media/UploadDropzone.tsx",
  // 018: the upload panel and engine word and check against the served limits only (FR-036).
  ...readdirSync("src/components/media/upload")
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
    .map((f) => `src/components/media/upload/${f}`),
  "src/lib/upload/precheck.ts",
  "src/lib/upload/engine.ts",
];

function numbersIn(value: unknown, out: Set<number>): void {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 100) out.add(value);
  } else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
}

// A line may opt out with `limit-literal-ok` when a number only coincides with a declared limit.
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.includes("limit-literal-ok"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("UI limit literals", () => {
  const declared = new Set<number>();
  // The library's own limits, as the server serves them (contracts/operations.md).
  const parsed = parseEnv({
    DATABASE_URL: "postgres://u:p@localhost:5432/d",
    BETTER_AUTH_SECRET: "test-secret-not-real-0123456789abcdef0123456789",
    BETTER_AUTH_URL: "http://localhost:3000",
    CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  });
  if (parsed.ok) numbersIn(libraryLimits(parsed.env), declared);
  declared.add(VIDEO_MAX_SIDE);
  const rules = new Set<string>();
  for (const p of listProviders()) {
    numbersIn(p.capabilities, declared);
    rules.add(countingRuleName(p.capabilities.text.countingRule));
  }

  it("reads the library limits from the default settings", () => {
    expect(parsed.ok).toBe(true);
    expect(declared.has(VIDEO_MAX_SIDE)).toBe(true);
  });

  it("reads declared limits from the providers", () => {
    expect(declared.size).toBeGreaterThan(0);
    expect(rules.size).toBeGreaterThan(0);
  });

  it.each(UI_FILES)("%s holds no MIME, counting-rule or declared-limit literal", (file) => {
    const src = stripComments(readFileSync(file, "utf8"));
    const bad: string[] = [];
    for (const m of src.matchAll(/["'`](?:image|video)\/[a-z0-9.+-]+["'`]/gi)) bad.push(`MIME ${m[0]}`);
    for (const rule of rules) if (new RegExp(`["'\`]${rule}["'\`]`).test(src)) bad.push(`counting rule "${rule}"`);
    for (const m of src.matchAll(/(?<![\w.])\d[\d_]*(?![\w.])/g)) {
      const n = Number(m[0].replace(/_/g, ""));
      if (declared.has(n)) bad.push(`declared limit ${n}`);
    }
    expect(bad).toEqual([]);
  });
});
