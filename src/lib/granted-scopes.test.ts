import { describe, expect, it } from "vitest";
import { normalizeGrantedScopes } from "./granted-scopes";

describe("normalizeGrantedScopes", () => {
  it("returns null for undefined", () => {
    expect(normalizeGrantedScopes(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(normalizeGrantedScopes(null)).toBeNull();
  });

  it("returns null for a non-array", () => {
    expect(normalizeGrantedScopes("read_insights")).toBeNull();
    expect(normalizeGrantedScopes({})).toBeNull();
    expect(normalizeGrantedScopes(42)).toBeNull();
  });

  it("returns [] for an empty array", () => {
    expect(normalizeGrantedScopes([])).toEqual([]);
  });

  it("rejects the whole list when an entry is Meta-token-shaped", () => {
    expect(
      normalizeGrantedScopes(["read_insights", "EAABwzLixnjYBAblahblahblah"]),
    ).toBeNull();
  });

  it("rejects the whole list when an entry is JWT-shaped", () => {
    expect(
      normalizeGrantedScopes([
        "read_insights",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ]),
    ).toBeNull();
  });

  it("rejects a non-string element", () => {
    expect(normalizeGrantedScopes(["read_insights", 123])).toBeNull();
  });

  it("rejects more than 40 entries", () => {
    const entries = Array.from({ length: 41 }, (_, i) => `scope_${i}`);
    expect(normalizeGrantedScopes(entries)).toBeNull();
  });

  it("rejects when the joined bytes exceed 1000", () => {
    const entries = Array.from({ length: 20 }, (_, i) => `a_very_long_scope_identifier_number_${i}_${"x".repeat(40)}`);
    expect(normalizeGrantedScopes(entries)).toBeNull();
  });

  it("dedupes, keeping platform order and the first occurrence", () => {
    expect(
      normalizeGrantedScopes(["read_insights", "instagram_basic", "read_insights"]),
    ).toEqual(["read_insights", "instagram_basic"]);
  });

  it("accepts a normal permission list unchanged in order", () => {
    expect(
      normalizeGrantedScopes(["instagram_basic", "pages_read_engagement"]),
    ).toEqual(["instagram_basic", "pages_read_engagement"]);
  });
});
