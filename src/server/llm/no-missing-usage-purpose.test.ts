import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { UsagePurpose } from "./usage";

// The closed set from data-model.md §2 — the enum values a `label:` literal reaching
// `llm.generate` must match. Kept in sync by hand, deliberately: widening it is a one-line review,
// not a refactor.
const USAGE_PURPOSES: readonly UsagePurpose[] = [
  "generate.single",
  "generate.series_plan",
  "generate.series_post",
  "generate.regenerate",
  "generate.job_item",
  "voice.try",
  "llm.check",
  "image.generate",
];

// Only label literals shaped like a usage purpose ("word.word") are in scope — a form field's
// "label:" ("Email address", "Display name", …) never matches this shape.
const LABEL_LITERAL = /\blabel:\s*["'`]([a-z]+\.[a-z_]+)["'`]/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Removes block and line comments (good enough for this guard; strings are kept). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("every label: literal reaching llm.generate in src/server has a matching UsagePurpose (P5)", () => {
  const offenders: { file: string; label: string }[] = [];
  for (const file of files(join("src", "server"))) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(LABEL_LITERAL)) {
      const label = match[1]!;
      if (!(USAGE_PURPOSES as readonly string[]).includes(label)) offenders.push({ file, label });
    }
  }
  expect(offenders).toEqual([]);
});

test("the closed set names exactly the eight call sites this entry adds", () => {
  const found = new Set<string>();
  for (const file of files(join("src", "server"))) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(LABEL_LITERAL)) found.add(match[1]!);
  }
  expect([...found].sort()).toEqual([...USAGE_PURPOSES].sort());
});
