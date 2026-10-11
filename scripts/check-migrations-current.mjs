// Fails when the committed migrations are out of date with the Drizzle schema (research D15).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://check:check@localhost:5432/check",
};

// Run drizzle-kit's entry file with this same node, rather than going through `pnpm exec`.
// `pnpm` on Windows is a `.cmd` shim that CreateProcess cannot execute, so spawning it returned
// ENOENT with `status: null` and no output. The checks below read only `status`, so that looked
// exactly like drizzle-kit reporting an inconsistent migration history, and the error printed
// `undefinedundefined` where its output belonged. Resolving the package and spawning node keeps
// it shell-free, so paths containing spaces need no quoting.
const drizzleKitBin = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs");

function run(args) {
  return spawnSync(process.execPath, [drizzleKitBin, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function fail(message, result) {
  console.error(message);
  // `error` is set when the process never started; `status` is null in that case, so without
  // this the real cause is invisible and the failure reads as a migration problem.
  if (result?.error) console.error(`could not run drizzle-kit: ${result.error.message}`);
  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
  if (output) console.error(output);
  process.exit(1);
}

const check = run(["check"]);
if (check.status !== 0) fail("drizzle-kit check failed: migration history is inconsistent.", check);

// Generate into a copy of ./drizzle; any new SQL file means the schema has drifted.
const dir = mkdtempSync(join(tmpdir(), "docket-migrations-"));
try {
  cpSync("drizzle", join(dir, "drizzle"), { recursive: true });
  const config = join(dir, "drizzle.config.mjs");
  // drizzle-kit resolves `schema` as a glob, and a backslash is an escape there rather than a
  // separator — so a Windows path matches nothing and it reports "No schema files found" for a
  // directory that plainly exists. Forward slashes work on both platforms.
  const posix = (p) => p.replaceAll("\\", "/");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      schema: posix(join(process.cwd(), "src/server/db/schema")),
      out: posix(join(dir, "drizzle")),
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
