// Drops test databases left behind by finished or killed test runs (rules: tests/setup/test-databases.ts).
// Dry run by default. Usage:
//   pnpm db:test:clean                       list what would be dropped
//   pnpm db:test:clean --yes                 drop it
//   pnpm db:test:clean --include-unlabeled   also unlabelled *_test databases (from before run labels)
//   pnpm db:test:clean --keep a_test,b_test  never drop these
//   pnpm db:test:clean --stale-hours 2       treat labelled runs older than 2 h as finished
// Connects to the server in DATABASE_URL (any database on it; the name is ignored).
import pg from "pg";
import { adminUrl, DEFAULT_STALE_HOURS, listDatabases, poolTolerantOfDrops, sweep } from "../tests/setup/test-databases";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL to any database on the Postgres server to clean.");
    return 2;
  }
  const yes = flag("--yes");
  const keep = new Set((arg("--keep") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const staleHours = Number(arg("--stale-hours") ?? DEFAULT_STALE_HOURS);
  if (!Number.isFinite(staleHours) || staleHours < 0) {
    console.error("--stale-hours must be a non-negative number.");
    return 2;
  }

  const admin = poolTolerantOfDrops(new pg.Pool({ connectionString: adminUrl(url), max: 1 }));
  try {
    const stale = await sweep(admin, { dryRun: !yes, includeUnlabeled: flag("--include-unlabeled"), keep, staleHours });
    const staleNames = new Set(stale.map((s) => s.name));
    for (const s of stale) console.log(`${yes ? "dropped" : "would drop"}  ${s.name}  (${s.reason})`);
    const kept = (await listDatabases(admin)).filter((d) => d.name.endsWith("_test") && !staleNames.has(d.name));
    for (const d of kept) {
      const why = keep.has(d.name) ? "kept by --keep" : d.connections > 0 ? `${d.connections} open connection(s)` : d.label ? `run ${d.label.docketTestRun} still active` : "unlabelled (pass --include-unlabeled)";
      console.log(`kept        ${d.name}  (${why})`);
    }
    if (!yes && stale.length > 0) console.log(`\n${stale.length} database(s) would be dropped. Re-run with --yes to drop them.`);
    return 0;
  } finally {
    await admin.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
