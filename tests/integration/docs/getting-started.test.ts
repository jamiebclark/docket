import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The guide is for people using the app, so it carries no commands or environment variable names (spec 033, SC-006).
const guide = readFileSync("docs/getting-started.md", "utf8");

describe("docs/getting-started.md", () => {
  it("has no code fences", () => {
    expect(guide).not.toContain("```");
  });

  it("names no shell commands", () => {
    expect(guide).not.toContain("pnpm ");
    expect(guide).not.toContain("docker ");
  });

  it("names no environment variables", () => {
    expect(guide).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
  });

  it("stays short enough to read in five minutes", () => {
    expect(guide.split(/\s+/).length).toBeLessThanOrEqual(900);
  });
});
