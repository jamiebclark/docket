import { describe, expect, it } from "vitest";
import { datedRowInputSchema, importDatedListSchema, importProblemSchema, importRecordSchema } from "./dated-rows";

describe("datedRowInputSchema", () => {
  it("accepts a well-formed row", () => {
    const result = datedRowInputSchema.parse({ date: "03-14", media: "ada.jpg", fields: { name: "Ada" } });
    expect(result.date).toBe("03-14");
  });

  it("allows media to be absent or null", () => {
    expect(datedRowInputSchema.parse({ date: "03-14", fields: {} }).media).toBeUndefined();
    expect(datedRowInputSchema.parse({ date: "03-14", media: null, fields: {} }).media).toBeNull();
  });

  it("rejects an empty date", () => {
    expect(() => datedRowInputSchema.parse({ date: "", fields: {} })).toThrow(/Enter a date/);
  });
});

describe("importDatedListSchema", () => {
  it("requires a non-empty filename", () => {
    expect(() => importDatedListSchema.parse({ filename: "" })).toThrow();
    expect(importDatedListSchema.parse({ filename: "list.csv" }).filename).toBe("list.csv");
  });
});

describe("importProblemSchema / importRecordSchema", () => {
  it("accepts a problem with a null line", () => {
    expect(importProblemSchema.parse({ line: null, message: "The file has no data rows" })).toEqual({
      line: null,
      message: "The file has no data rows",
    });
  });

  it("accepts an import record with up to 100 problems", () => {
    const record = {
      filename: "list.csv",
      at: new Date().toISOString(),
      rowCount: 3,
      problems: [{ line: 2, message: "bad" }],
    };
    expect(importRecordSchema.parse(record)).toEqual(record);
  });

  it("rejects more than 100 problems", () => {
    const problems = Array.from({ length: 101 }, (_, i) => ({ line: i, message: "x" }));
    expect(() =>
      importRecordSchema.parse({ filename: "a", at: new Date().toISOString(), rowCount: 1, problems }),
    ).toThrow();
  });
});
