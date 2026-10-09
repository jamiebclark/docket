import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { docsUrl } from "../../../src/lib/docs";
import { tiktokConnectGroup } from "../../../src/providers/tiktok/connect-group";

const root = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const VAR = /\bTIKTOK_[A-Z0-9_]+\b/g;
const varsIn = (text: string) => new Set(text.match(VAR) ?? []);

/** GitHub-style slugs of every heading in a markdown file. */
function slugs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    out.add(m[1]!.toLowerCase().replace(/`/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"));
  }
  return out;
}

describe("TikTok setup documentation", () => {
  const doc = read("docs/tiktok-setup.md");

  it("opens with the unverified-steps notice", () => {
    const intro = doc.slice(0, doc.indexOf("## Before you start"));
    expect(intro).toMatch(/Unverified steps/);
    expect(intro).toMatch(/mocks only/i);
    expect(doc).toMatch(/unverified/i);
  });

  it("documents the declared variables and names only TIKTOK_ variables that .env.example has", () => {
    const example = varsIn(read(".env.example"));
    const documented = varsIn(doc);
    for (const v of tiktokConnectGroup.environment.variables) {
      expect(documented, v.name).toContain(v.name);
      expect(example, v.name).toContain(v.name);
    }
    for (const name of documented) expect(example, `${name} in docs/tiktok-setup.md`).toContain(name);
  });

  it("has the headings that the connect group and messages link to", () => {
    expect(tiktokConnectGroup.redirectRequirement?.doc).toBe(docsUrl("tiktok-setup", "callback-address"));
    const found = slugs(doc);
    for (const anchor of ["callback-address", "unaudited-apps", "photo-posts-and-domain-verification", "owed-live-checks"]) {
      expect(found, anchor).toContain(anchor);
    }
  });

  it("covers scopes, the audit, consent risk and what is out of scope", () => {
    for (const scope of ["user.info.basic", "video.publish"]) expect(doc, scope).toMatch(new RegExp(`\\| \`${scope.replace(".", "\\.")}\` \\|`));
    expect(doc).toMatch(/Terms of Service URL/);
    expect(doc).toMatch(/at most 10/);
    expect(doc).toMatch(/5 users/);
    expect(doc).toMatch(/demo video/i);
    expect(doc).toMatch(/consent/i);
    expect(doc).toMatch(/confirm-at-send/);
    expect(doc).toMatch(/^#+ Not supported\s*$/m);
  });

  it("resolves every relative link and anchor in the TikTok pages", () => {
    for (const file of ["docs/tiktok-setup.md", "docs/accounts.md", "docs/feature-map.md", "docs/index.md", "docs/adding-a-provider.md"]) {
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
    expect(read("mkdocs.yml")).toContain("tiktok-setup.md");
    expect(read("docs/index.md")).toContain("tiktok-setup.md");
    expect(read("README.md")).toContain("docs/tiktok-setup.md");
    expect(read("docs/decisions.md")).toMatch(/^## 026 — TikTok provider/m);
  });
});
