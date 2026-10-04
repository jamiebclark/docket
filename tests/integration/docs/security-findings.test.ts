import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// docs/security.md is the FR-028 findings record; SC-011 says none may be open without a reason.
const rows = readFileSync("docs/security.md", "utf8")
  .split("\n")
  .filter((l) => l.startsWith("|"))
  .slice(2) // header and separator
  .map((l) => l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim()));

const AREAS = [
  /secrets in logs/i,
  /secrets in responses/i,
  /secrets in rendered ui/i,
  /attempt logs/i,
  /error messages/i,
  /csrf/i,
  /tick secret/i,
  /webhook secrets/i,
  /webhook destinations/i,
  /security headers/i,
  /request size/i,
  /outbound fetches/i,
  /session cookie/i,
  /sign-in rate limits/i,
  /existence leaks/i,
];

describe("docs/security.md", () => {
  it("has six columns in every row", () => {
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row, row[0]).toHaveLength(6);
  });

  it("covers every area FR-028 lists", () => {
    for (const area of AREAS) expect(rows.some((r) => area.test(r[0]!)), String(area)).toBe(true);
  });

  it("gives every row a finding, a severity, a fix or accepted reason, and tests that exist", () => {
    for (const [area, checked, finding, severity, resolution, tests] of rows as [string, string, string, string, string, string][]) {
      expect(checked, area).not.toBe("");
      expect(finding, area).not.toBe("");
      expect(severity, area).toMatch(/^(none|low|medium|high)$/);
      expect(resolution, area).toMatch(/^(Fixed|Accepted): \S/);
      const paths = [...tests.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      expect(paths.length, `${area} names no test`).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(p), `${area}: ${p} does not exist`).toBe(true);
    }
  });

  it("leaves nothing open", () => {
    expect(rows.filter((r) => /^(open|todo|tbd)/i.test(r[4]!))).toEqual([]);
  });
});
