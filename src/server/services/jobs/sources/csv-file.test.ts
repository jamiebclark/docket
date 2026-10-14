import { describe, expect, it } from "vitest";
import { CSV_MAX_BYTES, parseCsvFile } from "./csv";

const enc = (s: string) => new TextEncoder().encode(s);
const scopesFor = (s: string | Uint8Array) => {
  const r = parseCsvFile(typeof s === "string" ? enc(s) : s);
  return r.problems.map((p) => ({ message: p.message, scope: p.scope }));
};

describe("parseCsvFile — scope tagging", () => {
  it("tags a file too large as file-scoped", () => {
    expect(scopesFor(new Uint8Array(CSV_MAX_BYTES + 1))).toEqual([
      { message: "The file is larger than 1 MB.", scope: "file" },
    ]);
  });

  it("tags invalid UTF-8 as file-scoped", () => {
    expect(scopesFor(new Uint8Array([0x61, 0x0a, 0xff, 0xfe]))).toEqual([
      { message: "The file is not UTF-8 text.", scope: "file" },
    ]);
  });

  it("tags an unclosed quote as file-scoped", () => {
    const [p] = scopesFor('a,b\n1,2\n3,"oops\n');
    expect(p?.scope).toBe("file");
  });

  it("tags header problems as file-scoped", () => {
    const list = scopesFor("a,,A,bad/name\n1,2,3,4");
    expect(list.every((p) => p.scope === "file")).toBe(true);
    expect(list.length).toBe(3);
  });

  it("tags no-data-rows as file-scoped", () => {
    expect(scopesFor("a,b\n,\n")).toEqual([{ message: "The file has no data rows", scope: "file" }]);
  });

  it("tags over-500 rows as file-scoped", () => {
    const list = scopesFor("a\n" + Array.from({ length: 501 }, (_, i) => `v${i}`).join("\n"));
    expect(list).toEqual([{ message: "The file has 501 data rows; the limit is 500", scope: "file" }]);
  });

  it("tags too-many-values and over-length rows as row-scoped", () => {
    const list = scopesFor(`a,b\n1,2,3\n${"x".repeat(50_001)},1`);
    expect(list).toEqual([
      { message: "Line 2: 3 values but the header has 2 columns", scope: "row" },
      { message: "Line 3: the row is longer than 50,000 characters", scope: "row" },
    ]);
  });

  it("returns columns and rows even when there are no problems", () => {
    const r = parseCsvFile(enc("name,price\nn0,0\n"));
    expect(r.problems).toEqual([]);
    expect(r.columns).toEqual(["name", "price"]);
    expect(r.rows).toEqual([{ line: 2, values: { name: "n0", price: "0" } }]);
  });
});
