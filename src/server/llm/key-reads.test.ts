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

const CIPHERTEXT_COLUMN = /\b(apiKeyEncrypted|api_key_encrypted)\b/;
const ALLOWED_CIPHERTEXT_FILES = [
  join("server", "db", "schema", "generation.ts"),
  join("server", "dal", "project-llm.ts"),
  join("server", "llm", "resolve.ts"),
].map((p) => join("src", p));

test("the project credential's ciphertext column is named only in the schema, project-llm.ts and resolve.ts", () => {
  const offenders = files("src").filter(
    (f) => !ALLOWED_CIPHERTEXT_FILES.some((allowed) => f.endsWith(allowed)) && CIPHERTEXT_COLUMN.test(readFileSync(f, "utf8")),
  );
  expect(offenders).toEqual([]);
});

// Since nothing outside those three files can even name the ciphertext column (asserted above), and the
// schema file never calls decryptSecret, decryptSecret can only be applied to it in project-llm.ts or
// resolve.ts. project-llm.ts's own text confirms it does not call decryptSecret itself.
test("project-llm.ts never decrypts the ciphertext it reads", () => {
  const src = readFileSync(join("src", "server", "dal", "project-llm.ts"), "utf8");
  expect(src).not.toMatch(/\bdecryptSecret\b/);
});
