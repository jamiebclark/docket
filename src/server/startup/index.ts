import { runMigrations } from "../db/migrate";
import { bootstrapFirstUser } from "../dal/install";
import { SetupUnavailableError } from "../dal/errors";
import { formatEnvIssues } from "../env";
import { parseLlmConfig } from "../llm/config";
import { validateConfiguration } from "./validate";
import { JOB_MIN_CALL_MS, JOB_PERSIST_RESERVE_MS } from "../scheduler/config";

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

  const validation = validateConfiguration(deps.env);
  if (!validation.ok) {
    console.error(formatEnvIssues(validation.issues));
    return deps.exit(1);
  }
  const env = validation.env;
  for (const line of validation.disabled) deps.log(`Docket: ${line}`);

  const llm = parseLlmConfig(deps.env);

  const neededMs = JOB_MIN_CALL_MS + JOB_PERSIST_RESERVE_MS;
  if (llm.ok && env.SCHEDULER_TICK_BUDGET_SECONDS * 1000 < neededMs) {
    deps.log(
      `Docket: generation jobs cannot run (SCHEDULER_TICK_BUDGET_SECONDS=${env.SCHEDULER_TICK_BUDGET_SECONDS} is below ${Math.ceil(neededMs / 1000)})`,
    );
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
