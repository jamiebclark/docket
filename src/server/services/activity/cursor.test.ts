import { describe, expect, it } from "vitest";
import { decodeActivityCursor, encodeActivityCursor } from "./cursor";

describe("activity cursor", () => {
  it("round-trips", () => {
    const c = { t: "2026-10-06T13:02:11.512Z", s: "42", d: "older" as const };
    const encoded = encodeActivityCursor(c);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityCursor(encoded)).toEqual(c);
    expect(decodeActivityCursor(encodeActivityCursor({ ...c, d: "newer" }))?.d).toBe("newer");
  });

  it("returns null for anything malformed", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const bad of [
      null,
      undefined,
      "",
      "not base64 !!",
      "x".repeat(300),
      enc("string"),
      enc(null),
      enc({ v: 1, t: "2026-10-06T13:02:11.512Z", s: "1", d: "older" }),
      enc({ v: 2, t: "2026-10-06", s: "1", d: "older" }),
      enc({ v: 2, t: "2026-13-06T13:02:11.512Z", s: "1", d: "older" }),
      enc({ v: 2, t: "2026-10-06T13:02:11.512Z", s: "-1", d: "older" }),
      enc({ v: 2, t: "2026-10-06T13:02:11.512Z", s: 1, d: "older" }),
      enc({ v: 2, t: "2026-10-06T13:02:11.512Z", s: "1", d: "sideways" }),
    ]) {
      expect(decodeActivityCursor(bad)).toBeNull();
    }
  });
});
