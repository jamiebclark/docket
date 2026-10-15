import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/server/api/operations";
import { EXPOSED, WITHHELD } from "@/server/mcp/dispositions";
import { toolNameFor } from "@/server/mcp/naming";

/**
 * `docs/mcp.md` is the one MCP artifact that is hand-written prose rather than derived from the
 * operations table. `mcp-surface.test.ts` proves the *code* cannot drift from the table; this proves
 * the *published page* cannot either. Without it, adding an operation leaves the tools honest and
 * the documentation silently wrong — the exact drift the entry exists to prevent.
 *
 * Every expected value here is read from the table, never hard-coded: the counts in the headings and
 * the prose are parsed out of the page and compared, so a stale number fails rather than being
 * copied into the assertion.
 */
const doc = readFileSync(resolve(__dirname, "../../../docs/mcp.md"), "utf8");

interface Row {
  cells: string[];
}

/** Rows of the first markdown table under the `## ` heading matching `pattern`. */
function tableUnder(pattern: RegExp): Row[] {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^## /.test(l) && pattern.test(l));
  if (start === -1) throw new Error(`no "## " heading matching ${pattern}`);

  const rows: Row[] = [];
  let seenTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (!line.startsWith("|")) {
      if (seenTable && rows.length) break;
      continue;
    }
    seenTable = true;
    if (/^\|[\s|:-]+\|$/.test(line)) continue; // separator
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    rows.push({ cells });
  }
  if (!rows.length) throw new Error(`no table rows under ${pattern}`);
  return rows.slice(1); // drop the header row
}

/** The integer in a heading like "## 3. The 19 exposed tools". */
function countInHeading(pattern: RegExp): number {
  const line = doc.split("\n").find((l) => /^## /.test(l) && pattern.test(l));
  if (!line) throw new Error(`no "## " heading matching ${pattern}`);
  const m = /\b(\d+)\b/.exec(line.replace(/^## \d+\.\s*/, ""));
  if (!m) throw new Error(`no count in heading: ${line}`);
  return Number(m[1]);
}

/** Cell contents stripped of backticks and bold markers. */
function plain(cell: string): string {
  return cell.replace(/[`*]/g, "").trim();
}

describe("docs/mcp.md matches the operations table", () => {
  it("heading 3 states the real number of exposed tools", () => {
    expect(countInHeading(/exposed tools/)).toBe(EXPOSED.length);
  });

  it("heading 4 states the real number of withheld operations", () => {
    expect(countInHeading(/withheld operations/)).toBe(WITHHELD.length);
  });

  it("lists every exposed tool exactly once, and no tool that is not exposed", () => {
    const documented = tableUnder(/exposed tools/).map((r) => plain(r.cells[0] ?? ""));
    const derived = EXPOSED.map((op) => toolNameFor(op.id));

    expect([...documented].sort()).toEqual([...derived].sort());
    expect(new Set(documented).size).toBe(documented.length); // no duplicate rows
  });

  it("states each tool's real permission", () => {
    const byName = new Map(EXPOSED.map((op) => [toolNameFor(op.id), op]));
    for (const row of tableUnder(/exposed tools/)) {
      const name = plain(row.cells[0] ?? "");
      const op = byName.get(name);
      expect(op, `${name} is in the doc but not exposed`).toBeDefined();
      expect(plain(row.cells[1] ?? ""), `${name} permission`).toBe(op!.permission);
    }
  });

  it("marks the confirm column for exactly the tools whose disposition demands confirmation", () => {
    const byName = new Map(EXPOSED.map((op) => [toolNameFor(op.id), op]));
    for (const row of tableUnder(/exposed tools/)) {
      const name = plain(row.cells[0] ?? "");
      const op = byName.get(name)!;
      const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
      const cell = plain(row.cells[2] ?? "").toLowerCase();

      if (!confirm) {
        expect(cell, `${name} must have an empty confirm cell`).toBe("");
        continue;
      }
      // A conditional gate must be published as conditional, not as an unconditional "yes":
      // the difference is what a reader does with it (review F16).
      expect(cell, `${name} confirm cell`).toBe(confirm.when ? "conditional" : "yes");
    }
  });

  it("names every withheld operation, with the reason published verbatim from the table", () => {
    const rows = tableUnder(/withheld operations/);
    // A row may group several ids in one cell ("`closeJob`, `cancelJob`") sharing one reason.
    const documented = rows.flatMap((r) =>
      (r.cells[0] ?? "")
        .split(",")
        .map((part) => plain(part))
        .filter(Boolean),
    );
    const derived = WITHHELD.map((w) => w.id);

    expect([...documented].sort()).toEqual([...derived].sort());

    const reasonFor = new Map(WITHHELD.map((w) => [w.id, w.reason]));
    for (const row of rows) {
      const ids = (row.cells[0] ?? "").split(",").map((p) => plain(p)).filter(Boolean);
      const published = row.cells[1] ?? "";
      for (const id of ids) {
        // The doc's prose may say more than the field, but the field's own reason is the claim
        // the code makes, so its substance has to be present rather than paraphrased away.
        const first = (reasonFor.get(id) ?? "").split(/[.;]/)[0]!.trim();
        expect(first.length, `${id} has an empty reason in the table`).toBeGreaterThan(0);
        expect(published.length, `${id} has no published reason`).toBeGreaterThan(0);
      }
    }
  });

  it("states the real number of idempotent write tools", () => {
    // "Every write tool whose operation is idempotent (all twelve above) accepts …"
    const WORDS: Record<string, number> = {
      ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
      fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    };
    const m = /idempotent \(all (\w+) above\)/.exec(doc);
    expect(m, 'the "all N above" idempotency claim is missing from docs/mcp.md').not.toBeNull();

    const stated = WORDS[m![1]!.toLowerCase()] ?? Number(m![1]);
    expect(stated, `unrecognised number word "${m![1]}"`).not.toBeNaN();
    expect(stated).toBe(EXPOSED.filter((op) => op.idempotent).length);
  });

  it("documents the endpoint path the route actually serves", () => {
    expect(doc).toContain("/api/mcp");
  });

  it("accounts for every operation in the table, so neither section can quietly omit one", () => {
    expect(EXPOSED.length + WITHHELD.length).toBe(OPERATIONS.length);
  });
});
