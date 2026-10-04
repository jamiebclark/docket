// Container entrypoint: validate configuration, apply database migrations, then start the HTTP
// server (FR-004, FR-031). Both happen here, before `server.js` is loaded, so bad configuration
// or a failed migration exits 1 before anything listens or migrates. First-account creation stays
// in src/server/startup, which skips the migration this script already did (DOCKET_PREMIGRATED=1).
import { pathToFileURL } from "node:url";
import { formatEnvIssues } from "../src/server/env";
import { validateConfiguration } from "../src/server/startup/validate";

const PG_URL = /^postgres(ql)?:\/\//;

/** Whether this script should migrate: with a usable URL (empty means unset, FR-033). */
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
  validate = validateConfiguration,
  log = console.log,
  error = console.error,
} = {}) {
  const validation = validate(env);
  if (!validation.ok) {
    error(formatEnvIssues(validation.issues));
    return false;
  }
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
