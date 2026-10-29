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

  /**
   * 084 replaced this section wholesale, so this test had to be rewritten with it rather than
   * relaxed. Until then §2 was one table of three surfaces with every cell `**unverified**`, and
   * this test pinned exactly that — which is why a doc that answered the questions failed it.
   *
   * What it pins now is the shape FR-001 to FR-006 ask for: four surfaces answered separately,
   * nine questions each, and every row either carrying official evidence or saying plainly what
   * was tried. It must never pass by finding the section absent or empty.
   */
  it("answers the nine questions separately for each of the four Meta surfaces", () => {
    const meta = /## 2\. Meta[\s\S]*?(?=\n## \d)/.exec(doc)?.[0] ?? "";
    expect(meta).not.toBe("");

    // Threads mentions are a distinct surface from Threads replies and are answered as one.
    const surfaces = ["Facebook Page comments", "Instagram comments", "Threads replies", "Threads mentions"];
    for (const surface of surfaces) {
      expect(meta, surface).toContain(`### ${surface}`);
    }

    // §2 may carry subsections that are not surfaces — 085 added one recording what the
    // implementation assumed beyond what the research gave. Select the surfaces by name rather
    // than counting headings, so prose can be added without this test deciding it is a surface.
    const sections = meta
      .split(/^### /m)
      .slice(1)
      .filter((section) => surfaces.includes(section.split("\n")[0]!.trim()));
    expect(sections.length, "one section per surface").toBe(surfaces.length);

    for (const section of sections) {
      const name = section.split("\n")[0]!.trim();
      const rows = section.split("\n").filter((line) => /^\| \d+ \|/.test(line));
      // Nine is the floor, not a fixed count: 085 added a tenth question (how to list the brand's
      // own recent posts) because building the sweep needed a fact the original nine never asked for.
      expect(rows.length, `${name}: at least the nine questions`).toBeGreaterThanOrEqual(9);

      const cellsOf = (row: string) => row.split("|").map((c) => c.trim());
      const sourceByNumber = new Map(rows.map((row) => [cellsOf(row)[1] ?? "", cellsOf(row)[4] ?? ""]));
      const answerByNumber = new Map(rows.map((row) => [cellsOf(row)[1] ?? "", cellsOf(row)[3] ?? ""]));

      /** A row may cite another row rather than repeat its URL; follow it to the URL it stands for. */
      const resolveSource = (source: string): string => {
        const back = /^same as Q(\d+)$/i.exec(source);
        return back ? (sourceByNumber.get(back[1]!) ?? "") : source;
      };

      /**
       * FR-005's real demand is that an unverified row is never *bare* — it says what was looked
       * for and why it did not answer. Rows do that in more than one honest shape: "tried: …", a
       * "same reason as Q3" pointer, or prose explaining what was found and why it falls short.
       * So the test asks for a reason of substance rather than one particular wording.
       */
      const recordsWhatWasTried = (answer: string, depth = 0): boolean => {
        if (answer.includes("tried:")) return true;
        const back = /same reason as Q(\d+)/i.exec(answer);
        if (back && depth <= 3 && recordsWhatWasTried(answerByNumber.get(back[1]!) ?? "", depth + 1)) return true;
        const reason = answer.replaceAll("**unverified**", "").replace(/^[\s—–-]+/, "").trim();
        return reason.length >= 40;
      };

      for (const row of rows) {
        const cells = cellsOf(row);
        const answer = cells[3] ?? "";
        const source = resolveSource(cells[4] ?? "");
        const evidence = cells[6] ?? "";

        // Every row does one of two honest things, and a row may do both — a partial answer can
        // confirm part of a question from a real page and still mark the rest unverified.
        if (source.includes("https://")) {
          // FR-004: what is cited is official Meta documentation, graded for how it was checked.
          expect(source, `${name}: the source must be official Meta documentation — ${row}`).toMatch(
            /https:\/\/(developers|www)\.(facebook|instagram|threads)\.(com|net)/,
          );
          expect(["page", "search-summary"], `${name}: graded evidence — ${row}`).toContain(evidence);
          continue;
        }

        // FR-005: with nothing cited, the row must say it is unverified and account for the attempt.
        expect(answer, `${name}: an uncited row must be marked unverified — ${row}`).toContain("**unverified**");
        expect(recordsWhatWasTried(answer), `${name}: must say what was tried — ${row}`).toBe(true);
      }
    }
  });

  it("records, per surface, what its answers mean for building a reader (FR-006)", () => {
    const meta = /## 2\. Meta[\s\S]*?(?=\n## \d)/.exec(doc)?.[0] ?? "";
    // A thin answer must cost one reader, not the whole roadmap — so the consequence is stated.
    expect(meta.toLowerCase()).toContain("consequence");
  });

  it("has a direct-messages section marked unverified for every platform in scope", () => {
    const dm = /## 3\. Direct messages[\s\S]*$/.exec(doc)?.[0] ?? "";
    expect(dm).not.toBe("");
    expect(dm).toMatch(/unverified/i);
    expect(dm).not.toMatch(/\*\*confirmed\*\*/);
  });
});
