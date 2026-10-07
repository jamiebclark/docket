import { describe, expect, it } from "vitest";
import { UnknownProviderError } from "./errors";
import { mediaConstraintsOf } from "./media";
import { readFileSync } from "node:fs";
import { findConnectGroup, findProvider, getProvider, listConnectGroups, listProviders } from "./registry";

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
  it("gives every custom counting rule a valid name and a zero count for empty text", () => {
    for (const p of listProviders()) {
      const rule = p.capabilities.text.countingRule;
      if (typeof rule === "string") continue;
      expect(rule.name, p.key).toMatch(/^[a-z0-9-]+$/);
      expect(rule.unit, p.key).not.toBe("");
      expect(rule.count(""), p.key).toBe(0);
    }
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
  describe("connect groups", () => {
    const groups = listConnectGroups();
    it("uses well-formed, unique group keys and one group object per key", () => {
      const keys = groups.map((g) => g.group.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(key).toMatch(/^[a-z0-9-]+$/);
      for (const p of listProviders()) {
        if (p.connect.strategy !== "oauth") continue;
        expect(findConnectGroup(p.connect.group.key)?.group, p.key).toBe(p.connect.group);
      }
    });
    it("gives oauth providers no connectAccount", () => {
      for (const p of listProviders()) {
        if (p.connect.strategy === "oauth") expect(p.connectAccount, p.key).toBeUndefined();
      }
    });
    it("only groups carry pasteToken, and its field is secret", () => {
      for (const p of listProviders()) expect(p.connect, p.key).not.toHaveProperty("pasteToken");
      for (const { group } of groups) {
        if (group.pasteToken) expect(group.pasteToken.field.secret, group.key).toBe(true);
      }
    });
    it("registers threads in its own connect group", () => {
      const entry = findConnectGroup("threads");
      expect(entry?.providers.map((p) => p.key)).toEqual(["threads"]);
      expect(entry?.group.environment.variables.map((v) => v.name)).toEqual([
        "THREADS_APP_ID",
        "THREADS_APP_SECRET",
        "THREADS_GRAPH_BASE",
      ]);
    });
    it("registers x in its own connect group", () => {
      const entry = findConnectGroup("x");
      expect(entry?.providers.map((p) => p.key)).toEqual(["x"]);
      expect(entry?.group.displayName).toBe("X");
      expect(entry?.group.environment.variables.map((v) => [v.name, v.secret])).toEqual([
        ["X_CLIENT_ID", false],
        ["X_CLIENT_SECRET", true],
      ]);
      expect(entry?.group.pasteToken).toBeUndefined();
    });

    it("documents every environment variable in .env.example", () => {
      const example = readFileSync(".env.example", "utf8");
      for (const { group } of groups) {
        for (const v of group.environment.variables) {
          expect(v.name, group.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
          expect(example, `${group.key}: ${v.name}`).toMatch(new RegExp(`^#?\\s*${v.name}=`, "m"));
        }
      }
    });
  });
});
