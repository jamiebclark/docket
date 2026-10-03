// Container entrypoint: apply database migrations, then start the HTTP server (FR-004).
// Migrating here, before `server.js` is loaded, means a failed migration exits 1 before
// anything listens. Env validation and first-account creation stay in src/server/startup,
// which skips the migration this script already did (DOCKET_PREMIGRATED=1).
import { pathToFileURL } from "node:url";

const PG_URL = /^postgres(ql)?:\/\//;

/** Whether this script should migrate: only with a usable URL; bad env is reported by startup. */
export function migrationUrl(env) {
  if (env.MIGRATE_ON_START === "false") return null;
  const url = env.DATABASE_URL_DIRECT || env.DATABASE_URL;
  return url && PG_URL.test(url) ? url : null;
}

async function defaultMigrate(url) {
  const [{ Pool }, { drizzle }, { migrate }] = await Promise.all([
    import("pg").then((m) => m.default ?? m),
    import("drizzle-orm/node-postgres"),
    import("drizzle-orm/node-postgres/migrator"),
  ]);
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

/** Resolves true when the server may start; false when migration failed (caller exits 1). */
export async function prestart({
  env = process.env,
  migrate = defaultMigrate,
  log = console.log,
  error = console.error,
} = {}) {
  const url = migrationUrl(env);
  if (!url) return true;
  try {
    await migrate(url);
    log("Docket: database migrations applied");
    env.DOCKET_PREMIGRATED = "1";
    return true;
  } catch (e) {
    const code = e && typeof e === "object" ? e.code : undefined;
    error(`Docket: database migration failed${code ? ` (${code})` : ""}. Not starting.`);
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await prestart())) process.exit(1);
  await import("../server.js");
}
