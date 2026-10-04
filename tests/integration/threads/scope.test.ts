import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../../src/server/db/schema";

// SC-009 / FR-033: Threads adds no table and no raw database access.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("Threads provider scope", () => {
  it("imports no database client or schema module under src/providers/threads", () => {
    const banned = /from\s+["'](pg|drizzle-orm\/node-postgres|[^"']*\/db(\/[^"']*)?)["']/;
    for (const file of sourceFiles("src/providers/threads")) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(banned);
    }
  });

  it("adds no table named for Threads", () => {
    const tables = (Object.values(schema) as unknown[])
      .filter((v): v is PgTable => is(v, PgTable))
      .map((t) => getTableName(t));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((n) => /thread/i.test(n))).toEqual([]);
  });
});
