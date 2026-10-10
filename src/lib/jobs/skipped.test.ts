import { describe, expect, it } from "vitest";
import { alreadyPostedReason } from "./skipped";

describe("alreadyPostedReason", () => {
  it("names the external id and says it already became a post", () => {
    expect(alreadyPostedReason("glen-42")).toBe('Already posted: "glen-42" became a post earlier.');
  });

  it("quotes whatever id it is given, unmodified", () => {
    expect(alreadyPostedReason("Record With Spaces")).toBe('Already posted: "Record With Spaces" became a post earlier.');
  });
});
