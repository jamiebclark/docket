import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/server/db/client";
import { closeDb } from "../helpers/db";

afterAll(closeDb);

/**
 * An `ON DELETE SET NULL` foreign key says "this reference may become unknown". A CHECK requiring
 * that same column to be NOT NULL says "it may not". A table carrying both cannot have its parent row
 * deleted: the cascade nulls the column, the check rejects it, and the delete fails with 23514.
 *
 * This is not hypothetical. Two of these shipped and both only surfaced as CI flakes, because the
 * only code that deletes a user in anger is a test:
 *   - `engagement_drafts_decision_names_person` (fixed in 0044) made any user who had decided a draft
 *     undeletable, and had been in the schema since 0036.
 *   - `engagement_reply_claims_member_decision_named` (fixed in 0045) did the same for any user who
 *     had released a claim by member decision. It was found only because fixing the first one left
 *     `delete from "user"` still failing.
 *
 * Both were missed twice by hand-written audits, so the check belongs here where it runs every time.
 */
const ALLOWED = new Map([
  // Not an actor column and not an audit fact: an occurrence is either settled (has an outcome) or
  // pending (has a position), so a pending occurrence whose position is deleted is genuinely invalid.
  // The fix is at the foreign key, not the check — deleting a position should cascade to its
  // occurrences or be refused — and which of those is right is a standing-series decision, not a
  // schema tidy-up. Listed so the debt is visible rather than silent.
  ["standing_series_occurrences.position_id", "needs a decision: should deleting a position cascade or be refused?"],
  // Provenance, not an actor: a model-origin draft records which voice version produced it, and
  // SET NULL destroys exactly the fact the check exists to guarantee. Same question — refuse deleting
  // a profile that drafts reference, or accept losing the provenance.
  ["engagement_drafts.voice_profile_id", "needs a decision: refuse deleting a referenced voice profile, or drop the provenance guarantee?"],
]);

describe("ON DELETE SET NULL columns are not required NOT NULL by a CHECK", () => {
  it("finds no new contradiction between a nulling foreign key and a check constraint", async () => {
    const checks = await getDb().execute<{ tbl: string; conname: string; def: string }>(sql`
      select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
      from pg_constraint where contype = 'c'`);
    const fks = await getDb().execute<{ tbl: string; col: string; parent: string }>(sql`
      select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as parent
      from pg_constraint c
      join unnest(c.conkey) k on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      where c.contype = 'f' and c.confdeltype = 'n'`);

    // Plain string matching, deliberately: the two hand audits that missed these were both broken by
    // regex escaping, and reported a clean result while matching nothing at all.
    const found: string[] = [];
    for (const f of fks.rows) {
      for (const ch of checks.rows) {
        if (ch.tbl !== f.tbl) continue;
        const requires =
          ch.def.includes(`${f.col} IS NOT NULL`) || ch.def.includes(`${f.col}) IS NOT NULL`);
        if (requires) found.push(`${f.tbl}.${f.col} -> ${f.parent} [${ch.conname}]`);
      }
    }

    // Self-check: a matcher that matches nothing would report success forever. The allowlist is
    // non-empty by construction, so it doubles as proof the matcher still works.
    expect(
      found.length,
      "the matcher found nothing at all, which means it is broken rather than that the schema is clean",
    ).toBeGreaterThan(0);

    const unexpected = found.filter((f) => !ALLOWED.has(f.split(" ")[0]!));
    expect(
      unexpected,
      `new SET NULL / CHECK NOT NULL contradiction. Deleting the parent row will fail with 23514.\n` +
        `Either let the column be unknown (require a sibling timestamp instead, as 0044 and 0045 do) ` +
        `or change the foreign key to CASCADE or RESTRICT. If it is deliberate, add it to ALLOWED with the reason.\n` +
        `found: ${found.join(", ")}`,
    ).toEqual([]);
  });
});
