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

  // 077: a second hazard, found the same way — an enum-to-text cast is not IMMUTABLE, so it can never
  // appear in an index predicate, and neither can a label a migration adds in its own batch (42P17 /
  // 55P04, research.md §1). A partial index may name only labels that existed before the batch.
  it("no migration puts an enum cast or a freshly added label inside an index predicate", () => {
    const addedByFile = new Map<string, string[]>();
    for (const file of files) {
      const labels = [...sql(file).matchAll(/ALTER TYPE .* ADD VALUE '([^']+)'/g)].map((m) => m[1]!);
      if (labels.length > 0) addedByFile.set(file, labels);
    }

    const offenders: string[] = [];
    for (const file of files) {
      const freshLabels = addedByFile.get(file) ?? [];
      for (const statement of sql(file).split("--> statement-breakpoint")) {
        if (!/CREATE (UNIQUE )?INDEX/.test(statement)) continue;
        const whereIdx = statement.search(/\bWHERE\b/);
        if (whereIdx === -1) continue;
        const predicate = statement.slice(whereIdx);
        if (predicate.includes("::text")) offenders.push(`${file}: cast in index predicate: ${predicate.trim().slice(0, 160)}`);
        for (const label of freshLabels) {
          if (predicate.includes(`'${label}'`)) offenders.push(`${file}: freshly added label '${label}' in index predicate`);
        }
      }
    }
    expect(offenders, "an index predicate may name only labels that existed before this migration's batch, with no ::text cast").toEqual([]);
  });

  it("every pair in the regenerated activity_events_kind_outcome CHECK is compared ::text", () => {
    for (const file of files) {
      const content = sql(file);
      if (!content.includes("activity_events_kind_outcome")) continue;
      const statement = content
        .split("--> statement-breakpoint")
        .find((s) => s.includes("activity_events_kind_outcome") && /ADD CONSTRAINT/.test(s));
      if (!statement) continue;
      const pairs = [...statement.matchAll(/\(kind(::text)?\s*=\s*'[^']+'\s*AND\s*outcome(::text)?\s*=\s*'[^']+'\)/g)];
      expect(pairs.length, `${file}: expected at least one kind/outcome pair`).toBeGreaterThan(0);
      for (const pair of pairs) {
        expect(pair[0], `${file}: ${pair[0]}`).toMatch(/kind::text\s*=\s*'[^']+'\s*AND\s*outcome::text\s*=\s*'[^']+'/);
      }
    }
  });

  it("the schema's kindOutcomePairs generator and the attention index both keep the discipline", () => {
    const schema = readFileSync("src/server/db/schema/activity.ts", "utf8");
    expect(schema).toContain("kind::text = '${k}' AND outcome::text = '${KIND_OUTCOME[k]}'");
    expect(schema).toContain("outcome} <> ALL (ARRAY['published', 'retrying', 'resolved', 'connect_failed']::activity_outcome[])");
  });
});
