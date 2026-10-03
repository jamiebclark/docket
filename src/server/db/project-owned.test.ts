import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { notProjectOwned, projectOwnedTables } from "./project-owned";
import * as schema from "./schema";

describe("project-owned registry", () => {
  const tables = (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableName(t));

  it("finds the schema tables", () => {
    expect(tables.length).toBeGreaterThanOrEqual(19);
  });

  it("lists every table in exactly one list", () => {
    const owned = projectOwnedTables.map((t) => t.table) as string[];
    for (const table of tables) {
      const hits = Number(owned.includes(table)) + Number((notProjectOwned as readonly string[]).includes(table));
      expect(hits, `table "${table}" must be in exactly one of projectOwnedTables / notProjectOwned`).toBe(1);
    }
  });

  it("does not list tables that do not exist", () => {
    for (const name of [...projectOwnedTables.map((t) => t.table), ...notProjectOwned]) {
      expect(tables).toContain(name);
    }
  });
});
