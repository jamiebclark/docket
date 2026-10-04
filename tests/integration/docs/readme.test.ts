import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

function headingSlugs(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
      m[1]!.toLowerCase().replace(/[`*]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"),
    ),
  );
}

describe("README.md", () => {
  it("only links to files and anchors that exist", () => {
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((l) => !/^[a-z]+:/i.test(l));
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      const [path, anchor] = link.split("#") as [string, string | undefined];
      const target = path === "" ? "README.md" : join(dirname("README.md"), path);
      expect(existsSync(target), link).toBe(true);
      if (anchor) expect(headingSlugs(readFileSync(target, "utf8")).has(anchor), link).toBe(true);
    }
  });

  it("only mentions pnpm scripts that exist", () => {
    const builtins = new Set(["install", "exec", "dlx", "add", "run"]);
    const used = [...readme.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g)].map((m) => m[1]!);
    expect(used).toEqual(expect.arrayContaining(["dev", "test", "lint", "typecheck"]));
    for (const name of used) expect(builtins.has(name) || name in pkg.scripts, name).toBe(true);
  });

  it("only names repository paths that exist", () => {
    const paths = [...readme.matchAll(/`((?:src|docs|tests|scripts)\/[\w./-]*[\w-])`/g)].map((m) => m[1]!);
    for (const path of paths) {
      if (path.includes("<")) continue;
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("follows the FR-039 section order", () => {
    const order = ["Features", "Quick start", "Configuration", "Architecture overview", "Documentation", "Adding a provider", "Testing and contributing", "License"];
    const found = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
    expect(found).toEqual(order);
  });
});
