import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { docsUrl } from "../../../src/lib/docs";
import { pinterestConnectGroup } from "../../../src/providers/pinterest/connect-group";

const root = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const VAR = /\bPINTEREST_[A-Z0-9_]+\b/g;
const varsIn = (text: string) => new Set(text.match(VAR) ?? []);

/** GitHub-style slugs of every heading in a markdown file. */
function slugs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    out.add(m[1]!.toLowerCase().replace(/`/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"));
  }
  return out;
}

describe("Pinterest setup documentation", () => {
  const doc = read("docs/pinterest-setup.md");

  it("leads with the business-account requirement", () => {
    const intro = doc.slice(0, doc.indexOf("\n## "));
    expect(intro).toMatch(/business account/i);
  });

  it("documents the declared variables and names only PINTEREST_ variables that .env.example has", () => {
    const example = varsIn(read(".env.example"));
    const documented = varsIn(doc);
    for (const v of pinterestConnectGroup.environment.variables) {
      expect(documented, v.name).toContain(v.name);
      expect(example, v.name).toContain(v.name);
    }
    for (const name of documented) expect(example, `${name} in docs/pinterest-setup.md`).toContain(name);
  });

  it("gives the exact callback address and the matched-exactly rule", () => {
    expect(pinterestConnectGroup.redirectRequirement?.doc).toBe(docsUrl("pinterest-setup", "callback-address"));
    expect(doc).toMatch(/connect\/callback/);
    expect(doc).toMatch(/matches? it exactly/i);
  });

  it("states the Trial visibility rule and what to submit for Standard access", () => {
    expect(doc).toMatch(/Trial/);
    expect(doc).toMatch(/visible only to (?:their|its) (?:creator|owner)/i);
    expect(doc).toMatch(/demo video/i);
    expect(doc).toMatch(/Standard/);
  });

  it("names the Trial rate limits", () => {
    expect(doc).toMatch(/100(?:\s|&nbsp;|\/)*(?:a minute|\/min|per minute)/i);
    expect(doc).toMatch(/300(?:\s|&nbsp;|\/)*(?:a day|\/day|per day)/i);
  });

  it("says api-sandbox is never called and the provider is verified against mocked responses only", () => {
    expect(doc).toMatch(/api-sandbox/);
    expect(doc).toMatch(/never call/i);
    expect(doc).toMatch(/mocked responses only/i);
  });

  it("lists the ten owed live checks plus the Trial-visibility check", () => {
    for (const id of ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9", "U10"]) {
      expect(doc, id).toMatch(new RegExp(`\\*\\*${id}\\*\\*`));
    }
    expect(doc).toMatch(/invisible to anyone but/i);
  });

  it("has the headings that the connect group and messages link to", () => {
    const found = slugs(doc);
    for (const anchor of ["callback-address", "owed-live-checks", "insights"]) {
      expect(found, anchor).toContain(anchor);
    }
  });

  it("states the PINTEREST_INSIGHTS_SCOPES flag, the pins:read permission and what each buys, with a default matching .env.example", () => {
    expect(doc).toMatch(/PINTEREST_INSIGHTS_SCOPES=true/);
    expect(doc).toMatch(/pins:read/);
    expect(read(".env.example")).toMatch(/# PINTEREST_INSIGHTS_SCOPES=false/);
  });

  it("resolves every relative link and anchor in the Pinterest pages", () => {
    for (const file of ["docs/pinterest-setup.md", "docs/accounts.md", "docs/feature-map.md", "docs/index.md", "docs/adding-a-provider.md"]) {
      const text = read(file);
      for (const m of text.matchAll(/\]\(([^)#\s]*)(?:#([^)\s]+))?\)/g)) {
        const [, target, anchor] = m;
        if (/^[a-z]+:/.test(target!)) continue;
        const path = target ? resolve(root, dirname(file), target) : resolve(root, file);
        expect(existsSync(path), `${file}: ${target}`).toBe(true);
        if (anchor && path.endsWith(".md")) {
          expect(slugs(readFileSync(path, "utf8")), `${file}: ${target}#${anchor}`).toContain(anchor);
        }
      }
    }
  });

  it("is in the published navigation and the docs index, and has a decisions entry", () => {
    expect(read("mkdocs.yml")).toContain("pinterest-setup.md");
    expect(read("docs/index.md")).toContain("pinterest-setup.md");
    expect(read("README.md")).toContain("docs/pinterest-setup.md");
    expect(read("docs/decisions.md")).toMatch(/^## 072 — Pinterest provider/m);
  });
});
