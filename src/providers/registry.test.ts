import { describe, expect, it } from "vitest";
import { UnknownProviderError } from "./errors";
import { mediaConstraintsOf } from "./media";
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
  it("declares consistent media constraints for every provider", () => {
    for (const p of listProviders()) expect(() => mediaConstraintsOf(p.capabilities), p.key).not.toThrow();
  });
  it("holds the connect and refresh invariants for every provider", () => {
    for (const p of listProviders()) {
      if (p.connectAccount) {
        expect(["credentials", "manual-token"], p.key).toContain(p.connect.strategy);
        expect(p.connect.strategy === "oauth" ? 0 : p.connect.fields.length, p.key).toBeGreaterThan(0);
      }
      if (p.connect.strategy !== "oauth") {
        const names = p.connect.fields.map((f) => f.name);
        expect(new Set(names).size, p.key).toBe(names.length);
        for (const f of p.connect.fields) {
          expect(f.name, p.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
          if (f.defaultValue !== undefined) {
            expect(f.optional, `${p.key}.${f.name}`).toBe(true);
            expect(f.secret, `${p.key}.${f.name}`).toBe(false);
          }
        }
      }
      if (p.needsRefresh) expect(p.refreshCredentials, p.key).toBeTypeOf("function");
    }
  });
  it("has a total stepFor on malformed state", () => {
    const content = { text: "", mediaCount: 0 };
    for (const p of listProviders()) {
      const settings = p.settingsSchema.parse({});
      for (const state of [null, undefined, 42, "x", [], {}, { step: "nope" }, { done: "many" }]) {
        const step = p.stepFor(state as never, settings, content);
        expect(step.name, p.key).toBeTypeOf("string");
        expect(step.mayPublish, p.key).toBeTypeOf("boolean");
      }
    }
  });
});
