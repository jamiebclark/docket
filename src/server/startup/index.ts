import { runMigrations } from "../db/migrate";
import { bootstrapFirstUser } from "../dal/install";
import { SetupUnavailableError } from "../dal/errors";
import { formatEnvIssues, parseEnv } from "../env";
import { providerEnvIssues } from "../provider-env";
import { parseLlmConfig } from "../llm/config";

export interface StartupDeps {
  env: Record<string, string | undefined>;
  exit: (code: number) => never;
  log: (message: string) => void;
  migrate: (url: string) => Promise<void>;
  bootstrap: (input: { name: string; email: string; password: string }) => Promise<unknown>;
}

const defaults = (): StartupDeps => ({
  env: process.env,
  exit: (code) => process.exit(code),
  log: (message) => console.log(message),
  migrate: (url) => runMigrations(url),
  bootstrap: (input) => bootstrapFirstUser(input),
});

/**
 * Runs before the server takes requests (research D14): validate env, migrate, then create the
 * first account from the environment. Output carries variable names only, never values.
 */
export async function runStartup(overrides: Partial<StartupDeps> = {}): Promise<void> {
  const deps = { ...defaults(), ...overrides };

  const parsed = parseEnv(deps.env);
  const issues = [...(parsed.ok ? [] : parsed.issues), ...providerEnvIssues(deps.env)];
  if (!parsed.ok || issues.length > 0) {
    console.error(formatEnvIssues(issues));
    return deps.exit(1);
  }
  const env = parsed.env;

  // Generation is optional: an unset or incomplete group is reported and startup carries on (never exits).
  const llm = parseLlmConfig(deps.env);
  if (!llm.ok) {
    deps.log(`Docket: generation disabled (${llm.problems.map((p) => `${p.name}: ${p.reason}`).join("; ")})`);
  }

  // scripts/prestart.mjs migrates before the server loads; don't repeat it.
  if (env.MIGRATE_ON_START && deps.env.DOCKET_PREMIGRATED !== "1") {
    try {
      await deps.migrate(env.DATABASE_URL_DIRECT);
      deps.log("Docket: database migrations applied");
    } catch (error) {
      const code = (error as { code?: string }).code;
      console.error(`Docket: database migration failed${code ? ` (${code})` : ""}. Not starting.`);
      return deps.exit(1);
    }
  }

  if (env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD) {
    try {
      await deps.bootstrap({
        name: env.BOOTSTRAP_ADMIN_NAME,
        email: env.BOOTSTRAP_ADMIN_EMAIL,
        password: env.BOOTSTRAP_ADMIN_PASSWORD,
      });
      deps.log("Docket: first account created from environment");
    } catch (error) {
      if (error instanceof SetupUnavailableError) {
        deps.log("Docket: first account skipped (accounts exist)");
        return;
      }
      console.error("Docket: could not create the first account. Not starting.");
      return deps.exit(1);
    }
  }
}
