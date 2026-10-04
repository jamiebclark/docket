import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
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
    const tables = Object.values(schema)
      .filter((v): v is Parameters<typeof getTableName>[0] => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v)
      .map((t) => getTableName(t));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((n) => /thread/i.test(n))).toEqual([]);
  });
});
