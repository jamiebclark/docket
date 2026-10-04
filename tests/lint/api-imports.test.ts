import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// FR-044: route handlers and operations reach data only through services. The pipeline files directly under
// src/server/api (auth, handle, idempotency) may use the DAL scope they authenticate into, but nothing here
// touches the database client, `pg` or `drizzle-orm`.
const DB = /["'](?:@\/server\/db(?:\/[^"']*)?|(?:\.\.?\/)+(?:server\/)?db(?:\/[^"']*)?|pg|drizzle-orm(?:\/[^"']*)?)["']/;
const DAL = /["'](?:@\/server\/dal(?:\/[^"']*)?|(?:\.\.?\/)+(?:server\/)?dal(?:\/[^"']*)?)["']/;
// Type-only imports and the error classes carry no data access.
const DAL_ALLOWED = /^\s*import\s+type\b|\/dal\/errors["']/;
// Repo access through the scope object the operation is handed: an import check cannot see it.
const SCOPE_REPO = /\bscope\.(jobs|jobItems|posts|media|accounts|targets|webhooks|apiKeys)\./;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

function importLines(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return src.split("\n").filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l) || /^\s*}\s*from\b/.test(l));
}

const strict = ["src/app/api/v1", "src/server/api/operations"].flatMap(files);
const operations = files("src/server/api/operations");
const pipeline = files("src/server/api");

describe("public API import boundary", () => {
  it("finds the API files", () => {
    expect(strict.length).toBeGreaterThan(3);
    expect(pipeline.length).toBeGreaterThan(strict.length - 1);
  });

  it.each(pipeline)("%s does not import the database", (file) => {
    expect(importLines(file).filter((l) => DB.test(l))).toEqual([]);
  });

  it.each(strict)("%s does not import the DAL for data access", (file) => {
    expect(importLines(file).filter((l) => DAL.test(l) && !DAL_ALLOWED.test(l))).toEqual([]);
  });

  it.each(operations)("%s reaches repos only through services, never `scope.<repo>.`", (file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines.filter((l) => SCOPE_REPO.test(l))).toEqual([]);
  });
});
