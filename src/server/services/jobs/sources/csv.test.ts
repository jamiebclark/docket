import { describe, expect, it } from "vitest";
import { CSV_MAX_BYTES, parseJobCsv } from "./csv";

const enc = (s: string) => new TextEncoder().encode(s);
const problems = (s: string | Uint8Array) => {
  const r = parseJobCsv(typeof s === "string" ? enc(s) : s);
  if (r.ok) throw new Error("expected refusal");
  return r.problems.map((p) => p.message);
};

describe("parseJobCsv", () => {
  it("parses rows, strips a BOM, and previews five", () => {
    const r = parseJobCsv(enc("﻿name,price\n" + Array.from({ length: 7 }, (_, i) => `n${i},${i}`).join("\n")));
    expect(r).toMatchObject({ ok: true, columns: ["name", "price"], rowCount: 7 });
    if (!r.ok) return;
    expect(r.preview).toHaveLength(5);
    expect(r.rows[0]).toEqual({ line: 2, values: { name: "n0", price: "0" } });
  });

  it("refuses a file over 1 MB without decoding", () => {
    expect(problems(new Uint8Array(CSV_MAX_BYTES + 1))).toEqual(["The file is larger than 1 MB."]);
  });

  it("refuses invalid UTF-8", () => {
    expect(problems(new Uint8Array([0x61, 0x0a, 0xff, 0xfe]))).toEqual(["The file is not UTF-8 text."]);
  });

  it("names the line of an unclosed quote", () => {
    const [msg] = problems('a,b\n1,2\n3,"oops\n');
    expect(msg).toMatch(/^Line \d+: a quoted value is not closed$/);
  });

  it("refuses empty, duplicate and unusable column names, listing them all", () => {
    const list = problems("a,,A,bad/name\n1,2,3,4");
    expect(list).toContain("Column 2 has no name");
    expect(list).toContain("Columns 1 and 3 have the same name");
    expect(list).toContain('Column "bad/name" can only use letters, numbers, spaces, _ - and .');
  });

  it("refuses a column name over 64 characters", () => {
    expect(problems(`${"x".repeat(65)}\n1`)[0]).toMatch(/can only use/);
  });

  it("refuses a row with too many values or over 50,000 characters", () => {
    const list = problems(`a,b\n1,2,3\n${"x".repeat(50_001)},1`);
    expect(list).toEqual([
      "Line 2: 3 values but the header has 2 columns",
      "Line 3: the row is longer than 50,000 characters",
    ]);
  });

  it("pads short rows and skips comma-only rows", () => {
    const r = parseJobCsv(enc("a,b,c\n1\n,,\n4,5,6\n"));
    expect(r).toMatchObject({ ok: true, rowCount: 2 });
    if (r.ok) expect(r.rows[0]!.values).toEqual({ a: "1", b: "", c: "" });
  });

  it("refuses 0 and 501 data rows", () => {
    expect(problems("a,b\n,\n")).toEqual(["The file has no data rows"]);
    expect(problems("a\n" + Array.from({ length: 501 }, (_, i) => `v${i}`).join("\n"))).toEqual([
      "The file has 501 data rows; the limit is 500",
    ]);
  });

  it("parses 500 rows within 2 seconds", () => {
    const text = "a,b\n" + Array.from({ length: 500 }, (_, i) => `v${i},"w ${i}"`).join("\n");
    const t = performance.now();
    expect(parseJobCsv(enc(text))).toMatchObject({ ok: true, rowCount: 500 });
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
