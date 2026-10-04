import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// A read is `process.env.X_API_KEY`, `env.X_API_KEY` or `env["X_API_KEY"]`; naming the variable in a message is fine.
const KEY_READ = /\benv\b\s*(\.\s*|\[\s*["'`])(OPENAI_API_KEY|ANTHROPIC_API_KEY)/;

test("provider API keys are read only in src/server/llm/config.ts", () => {
  const offenders = [...files("src"), ...files("scripts")].filter(
    (f) => !f.endsWith(join("llm", "config.ts")) && KEY_READ.test(readFileSync(f, "utf8")),
  );
  expect(offenders).toEqual([]);
});
