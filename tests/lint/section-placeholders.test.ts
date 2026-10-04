import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = "src/app/p/[projectSlug]";

describe("section placeholders", () => {
  it("has no catch-all placeholder route left", () => {
    expect(existsSync(`${ROOT}/[section]`)).toBe(false);
  });

  it.each(["calendar", "posts", "compose", "media", "accounts", "generate", "review", "voice", "jobs"])(
    "%s has its own page",
    (section) => {
      expect(existsSync(`${ROOT}/${section}/page.tsx`)).toBe(true);
    },
  );
});
