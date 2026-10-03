import { describe, expect, it } from "vitest";
import { UnknownProviderError } from "./errors";
import { findProvider, getProvider, listProviders } from "./registry";

describe("provider registry", () => {
  it("finds the mock provider", () => {
    expect(findProvider("mock")?.key).toBe("mock");
    expect(getProvider("mock").displayName).toBe("Mock (offline)");
  });
  it("returns undefined for an unknown key, and getProvider throws", () => {
    expect(findProvider("nope")).toBeUndefined();
    expect(() => getProvider("nope")).toThrow(UnknownProviderError);
  });
  it("has unique, well-formed keys", () => {
    const keys = listProviders().map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9-]+$/);
  });
});
