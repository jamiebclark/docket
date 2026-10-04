import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = "src/app/p/[projectSlug]";

describe("section placeholders", () => {
  it("lists only the sections that have no screen yet", () => {
    const src = readFileSync(`${ROOT}/[section]/page.tsx`, "utf8");
    const block = /const PLACEHOLDERS[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? "";
    const keys = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["jobs"]);
  });

  it.each(["calendar", "posts", "compose", "media", "accounts", "generate", "review", "voice"])("%s has its own page", (section) => {
    expect(existsSync(`${ROOT}/${section}/page.tsx`)).toBe(true);
  });
});
