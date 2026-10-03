// Fails when the committed migrations are out of date with the Drizzle schema (research D15).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://check:check@localhost:5432/check",
};

function run(args) {
  return spawnSync("pnpm", ["exec", "drizzle-kit", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function fail(message, result) {
  console.error(message);
  if (result) console.error(`${result.stdout}${result.stderr}`.trim());
  process.exit(1);
}

const check = run(["check"]);
if (check.status !== 0) fail("drizzle-kit check failed: migration history is inconsistent.", check);

// Generate into a copy of ./drizzle; any new SQL file means the schema has drifted.
const dir = mkdtempSync(join(tmpdir(), "docket-migrations-"));
try {
  cpSync("drizzle", join(dir, "drizzle"), { recursive: true });
  const config = join(dir, "drizzle.config.mjs");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      schema: join(process.cwd(), "src/server/db/schema"),
      out: join(dir, "drizzle"),
      dialect: "postgresql",
    })};`,
  );
  const before = readdirSync(join(dir, "drizzle")).filter((f) => f.endsWith(".sql")).length;
  const gen = run(["generate", "--config", config]);
  if (gen.status !== 0) fail("drizzle-kit generate failed.", gen);
  const after = readdirSync(join(dir, "drizzle")).filter((f) => f.endsWith(".sql")).length;
  if (after !== before) {
    fail("Schema changed without a migration. Run `pnpm db:generate` and commit the result.");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Migrations are current.");
