import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = join(__dirname);

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

describe("page titles (FR-041)", () => {
  const files = pages(APP_DIR);

  it("finds the app's pages", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(APP_DIR.length + 1), f]))(
    "%s exports metadata or generateMetadata",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(
        /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b|const\s+generateMetadata\b)/,
      );
    },
  );
});
