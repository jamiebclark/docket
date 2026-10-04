// docket-ui conventions for the 007 screens: loading states, labelled controls and the server-only boundary.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = __dirname;
const ROUTES = ["generate", "generate/result/[postId]", "generate/series/[seriesId]", "review", "voice", "voice/[profileId]"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const clientFiles = ROUTES.flatMap((r) => walk(join(ROOT, r)))
  .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
  .filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

/** Opening tags for `name`, scanning to the closing `>` while ignoring `>` inside `{…}`. */
function openingTags(source: string, name: string): { tag: string; before: string }[] {
  const out: { tag: string; before: string }[] = [];
  const re = new RegExp(`<${name}(?=[\\s/>])`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    let i = m.index;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ tag: source.slice(m.index, i + 1), before: source.slice(0, m.index) });
  }
  return out;
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("007 UI conventions", () => {
  it.each(ROUTES)("%s has a loading.tsx", (route) => {
    expect(existsSync(join(ROOT, route, "loading.tsx"))).toBe(true);
  });

  it("finds the client components it is meant to check", () => {
    expect(clientFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(clientFiles.map((f) => [f.slice(ROOT.length + 1), f]))("%s: every textarea and input has a label", (_name, file) => {
    const source = readFileSync(file as string, "utf8");
    const unlabelled: string[] = [];
    for (const name of ["textarea", "input", "select"]) {
      for (const { tag, before } of openingTags(source, name)) {
        if (/type="hidden"/.test(tag)) continue;
        const named = /aria-label(ledby)?=/.test(tag);
        const linked = /\bid=/.test(tag) && /htmlFor=/.test(source);
        const wrapped = count(before, "<label") > count(before, "</label>");
        if (!named && !linked && !wrapped) unlabelled.push(tag.replace(/\s+/g, " ").slice(0, 80));
      }
    }
    expect(unlabelled).toEqual([]);
  });

  it.each(clientFiles.map((f) => [f.slice(ROOT.length + 1), f]))("%s keeps the server-only boundary", (_name, file) => {
    const source = readFileSync(file as string, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    const bad = imports.filter((p) => /(^|\/)server\/(llm|services\/generation|db)(\/|$)/.test(p));
    expect(bad).toEqual([]);
  });
});
