import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_BASE_URL, docsUrl } from "@/lib/docs";

// The app links to the published site (mkdocs.yml), so a renamed page or heading would break a link without failing
// anything else. Every docsUrl(...) call in src/ must name a page in the site's nav and, if given, a heading on it.

const mkdocs = readFileSync("mkdocs.yml", "utf8");

function headingSlugs(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
      m[1]!.toLowerCase().replace(/[`*]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"),
    ),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const calls = sourceFiles("src").flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/docsUrl\("([\w-]+)"(?:,\s*"([\w-]+)")?\)/g)].map((m) => ({
    file,
    page: m[1]!,
    anchor: m[2],
  })),
);

describe("links to the published docs", () => {
  it("builds URLs under the site_url in mkdocs.yml", () => {
    expect(mkdocs).toContain(`site_url: ${DOCS_BASE_URL}`);
    expect(docsUrl("getting-started")).toBe(`${DOCS_BASE_URL}getting-started/`);
    expect(docsUrl("n8n", "6-verifying-webhook-signatures")).toBe(`${DOCS_BASE_URL}n8n/#6-verifying-webhook-signatures`);
  });

  it("is used by the app", () => {
    expect(calls.length).toBeGreaterThan(5);
  });

  it("only names pages in the site nav and headings that exist", () => {
    for (const { file, page, anchor } of calls) {
      const where = `${file}: ${page}${anchor ? `#${anchor}` : ""}`;
      const doc = `docs/${page}.md`;
      expect(existsSync(doc), where).toBe(true);
      expect(mkdocs, where).toContain(`: ${page}.md`);
      if (anchor) expect(headingSlugs(readFileSync(doc, "utf8")).has(anchor), where).toBe(true);
    }
  });
});
