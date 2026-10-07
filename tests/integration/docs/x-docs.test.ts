import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { docsUrl } from "../../../src/lib/docs";
import { xConnectGroup } from "../../../src/providers/x/connect-group";

const root = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const X_VAR = /\bX_[A-Z0-9_]+\b/g;
const varsIn = (text: string) => new Set(text.match(X_VAR) ?? []);

describe("X setup documentation", () => {
  const doc = read("docs/x-setup.md");
  const envExample = read(".env.example");
  const declared = xConnectGroup.environment.variables.map((v) => v.name);

  it("opens with the not-checked-against-X notice", () => {
    const firstParagraph = doc.split("\n").filter((l) => l.trim() && !l.startsWith("# "))[0] ?? "";
    expect(firstParagraph).toMatch(/not checked against the real X API/i);
  });

  it("lists every unverified item U1 to U9", () => {
    for (let i = 1; i <= 9; i += 1) expect(doc, `U${i}`).toMatch(new RegExp(`\\*\\*U${i}\\.\\*\\*`));
  });

  it("documents the declared variables and names only X_ variables that .env.example has", () => {
    const example = varsIn(envExample);
    const documented = varsIn(doc);
    for (const name of declared) {
      expect(documented, name).toContain(name);
      expect(example, name).toContain(name);
    }
    for (const name of documented) {
      if (name.startsWith("X_REFRESH") || name === "X_API_BASE") continue;
      expect(example, `${name} in docs/x-setup.md`).toContain(name);
    }
  });

  it("has the callback-address heading that the G10 message links to", () => {
    expect(doc).toMatch(/^#+ Callback address\s*$/m);
    expect(xConnectGroup.redirectRequirement?.doc).toBe(docsUrl("x-setup", "callback-address"));
  });

  it("covers cost, scopes, credits, alt text, ambiguity and what is out of scope", () => {
    expect(doc).toMatch(/^#+ Cost and credits\s*$/m);
    expect(doc).toMatch(/auto-recharge/i);
    expect(doc).toMatch(/spending limit/i);
    expect(doc).toContain("$0.015");
    expect(doc).toContain("$0.20");
    expect(doc).toContain("$0.001");
    expect(doc).toMatch(/promotional/i);
    expect(doc).toMatch(/2026-10-06/);
    for (const scope of ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"]) {
      expect(doc, scope).toMatch(new RegExp(`\\| \`${scope.replace(".", "\\.")}\` \\|`));
    }
    expect(doc).toMatch(/credits run out/i);
    expect(doc).toMatch(/1,000/);
    expect(doc).toMatch(/^#+ When a post is ambiguous\s*$/m);
    expect(doc).toMatch(/profile on X/i);
    expect(doc).toMatch(/^#+ Not supported\s*$/m);
    expect(doc).toContain("X refused this as a duplicate of a recent post.");
  });

  it("is in the published navigation", () => {
    expect(read("mkdocs.yml")).toContain("x-setup.md");
  });
});
