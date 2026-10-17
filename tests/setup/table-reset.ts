// The pure SQL for a per-test reset: empty every table, then restore the rows a freshly
// migrated database contains. Order-independent — `projects` and `voice_profiles` form a genuine
// foreign-key cycle (no topological delete order exists), so callers must run this under
// `session_replication_role = replica` to turn FK triggers off for the transaction.

/** Rows a freshly migrated database contains, re-inserted after the delete (data-model.md section 2). */
export const PRESERVED_ROWS: readonly { table: string; sql: string }[] = [
  {
    table: "notification_change_marker",
    sql: `insert into "notification_change_marker" ("id") values (true) on conflict do nothing`,
  },
];

/** One `delete from` per table, plus the preserved-row re-inserts. Pure; takes no connection. */
export function resetStatements(tables: readonly string[]): string {
  const deletes = tables.map((table) => `delete from "${table}"`);
  const inserts = PRESERVED_ROWS.map((row) => row.sql);
  return [...deletes, ...inserts].join(";\n") + ";";
}
