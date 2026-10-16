import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const path = resolve(root, "docs/research/engagement.md");

describe("docs/research/engagement.md (FR-001, FR-002, FR-003, SC-010)", () => {
  it("exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  const doc = existsSync(path) ? readFileSync(path, "utf8") : "";

  it("carries a dated \"checked on\" line", () => {
    expect(doc).toMatch(/^Checked \d{4}-\d{2}-\d{2}\b/m);
  });

  it("has a Bluesky section with an explicit verdict", () => {
    const bluesky = /## 1\. Bluesky[\s\S]*?(?=\n## \d)/.exec(doc)?.[0] ?? "";
    expect(bluesky).not.toBe("");
    expect(bluesky).toMatch(/\*\*confirmed\*\*/);
  });

  it("marks every FR-001 question unverified for each in-scope Meta surface", () => {
    const meta = /## 2\. Meta[\s\S]*?(?=\n## \d)/.exec(doc)?.[0] ?? "";
    expect(meta).not.toBe("");
    for (const surface of ["Facebook Page comments", "Instagram comments", "Threads replies"]) {
      expect(meta, surface).toContain(surface);
    }
    const questions = [
      "How are inbound items read",
      "Which permission does the read require",
      "What identity fields does a commenter carry",
      "Is that identifier stable across two comments",
      "Can a reply be sent at the access level",
      "How are results paginated",
      "What are the read rate limits",
    ];
    for (const q of questions) {
      expect(meta, q).toContain(q);
    }
    // One row per question, three surface cells each — every cell in those rows must say unverified.
    const rows = meta.split("\n").filter((line) => line.startsWith("|") && questions.some((q) => line.includes(q)));
    expect(rows.length).toBe(questions.length);
    for (const row of rows) {
      const cells = row.split("|").slice(2, -1);
      expect(cells.length, row).toBe(3);
      for (const cell of cells) expect(cell, row).toContain("**unverified**");
    }
  });

  it("has a direct-messages section marked unverified for every platform in scope", () => {
    const dm = /## 3\. Direct messages[\s\S]*$/.exec(doc)?.[0] ?? "";
    expect(dm).not.toBe("");
    expect(dm).toMatch(/unverified/i);
    expect(dm).not.toMatch(/\*\*confirmed\*\*/);
  });
});
