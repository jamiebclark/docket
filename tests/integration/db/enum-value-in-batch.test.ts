import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Drizzle applies every pending migration inside ONE transaction
 * (drizzle-orm/pg-core/dialect.js: `session.transaction(...)` wraps the whole loop), and Postgres
 * refuses to use an enum label added by `ALTER TYPE ... ADD VALUE` until that transaction commits:
 *
 *     55P04 unsafe use of new value "date" of enum type standing_series_period
 *
 * A fresh database never hits this, because the enum type is created in the same transaction, which
 * Postgres allows. Only an existing install fails — so CI, which always migrates from scratch, was
 * green while every upgrade broke. That is exactly how 0031 shipped.
 *
 * The fix is to compare the column as text. This guards the two constraints that were caught.
 */
const MIGRATIONS = "drizzle";

function sql(tag: string): string {
  return readFileSync(`${MIGRATIONS}/${tag}`, "utf8");
}

describe("enum labels added mid-batch are never compared as enums", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));

  it("'date' is added by a migration, so every comparison to it must cast to text", () => {
    const added = files.filter((f) => /ALTER TYPE .* ADD VALUE 'date'/.test(sql(f)));
    expect(added.length, "expected a migration that adds the 'date' label").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const line of sql(file).split("\n")) {
        const comparesToDate = /(<>|=|IS DISTINCT FROM)\s*'date'/.test(line);
        if (!comparesToDate) continue;
        // A comparison is safe when the column is cast to text first.
        if (!line.includes("::text")) offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
      }
    }
    expect(offenders, "compare the column ::text, or Postgres answers 55P04 on every upgrade").toEqual([]);
  });

  it("the schema source keeps the casts, so a regenerate cannot quietly drop them", () => {
    const schema = readFileSync("src/server/db/schema/standing-series.ts", "utf8");
    expect(schema).toContain("${t.cadencePeriod}::text IS DISTINCT FROM 'date'");
    expect(schema).toContain("${t.period}::text <> 'date'");
  });
});
