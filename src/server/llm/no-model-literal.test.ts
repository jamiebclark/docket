import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const MODEL_ID = /\b(gpt-[\w.-]+|claude-[\w.-]+|o[134]-[\w.-]+|chatgpt-[\w.-]+)/i;

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

test("no model id literal appears in src/ outside comments (FR-003)", () => {
  const offenders = files("src").filter((f) => MODEL_ID.test(stripComments(readFileSync(f, "utf8"))));
  expect(offenders).toEqual([]);
});
