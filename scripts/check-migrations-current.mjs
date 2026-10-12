// Fails when the committed migrations are out of date with the Drizzle schema (research D15).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://check:check@localhost:5432/check",
};

// On Windows `pnpm` is a `.cmd` shim, and since the CVE-2024-27980 fix Node refuses to spawn one without a
// shell — `spawnSync("pnpm", …)` fails with ENOENT before drizzle-kit ever runs. Shelling out means the
// shell re-splits the arguments, so quote the ones that can contain spaces (the temp config path does, when
// the user profile name does).
const windows = process.platform === "win32";

function run(args) {
  const argv = ["exec", "drizzle-kit", ...args];
  return spawnSync("pnpm", windows ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : argv, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: windows,
  });
}

/** drizzle-kit globs the schema path, and a Windows backslash path never matches. */
const posix = (p) => p.split("\\").join("/");

function fail(message, result) {
  console.error(message);
  if (result) {
    // A failure to spawn at all leaves stdout and stderr undefined; printing them raw said
    // "undefinedundefined" and hid the real cause.
    const detail = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("").trim();
    console.error(detail || `drizzle-kit did not run (status ${result.status}, signal ${result.signal}).`);
  }
  process.exit(1);
}

const check = run(["check"]);
if (check.status !== 0) fail("drizzle-kit check failed: migration history is inconsistent.", check);

// Generate into a copy of ./drizzle; any new SQL file means the schema has drifted.
//
// Every path in the config must be RELATIVE to the repository root. drizzle-kit joins `out` onto its cwd,
// so an absolute path becomes `<repo>/C:/Users/.../drizzle` (or `<repo>/tmp/...` on POSIX): it then cannot
// read a single snapshot, emits nothing — and still exits 0. That silently turned this whole gate into a
// no-op, because `after === before` is also what "no drift" looks like. The copy therefore lives under
// `node_modules/.cache`, which is inside the root and already ignored.
const cacheRoot = join("node_modules", ".cache");
mkdirSync(cacheRoot, { recursive: true });
const dir = mkdtempSync(join(cacheRoot, "docket-migrations-"));
try {
  cpSync("drizzle", join(dir, "drizzle"), { recursive: true });
  const config = join(dir, "drizzle.config.mjs");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      schema: "src/server/db/schema",
      out: posix(join(dir, "drizzle")),
      dialect: "postgresql",
    })};`,
  );
  const before = readdirSync(join(dir, "drizzle")).filter((f) => f.endsWith(".sql")).length;
  const gen = run(["generate", "--config", config]);
  if (gen.status !== 0) fail("drizzle-kit generate failed.", gen);

  // drizzle-kit can fail internally and still exit 0, so "no new file" alone does not mean "no drift".
  // Require positive evidence that it compared the schema against the snapshots.
  const out = `${gen.stdout ?? ""}${gen.stderr ?? ""}`;
  if (/ENOENT|No schema files found|error:/i.test(out) || !/No schema changes|migration file/i.test(out)) {
    fail("drizzle-kit generate did not compare the schema; this check proves nothing as written.", gen);
  }

  const after = readdirSync(join(dir, "drizzle")).filter((f) => f.endsWith(".sql")).length;
  if (after !== before) {
    fail("Schema changed without a migration. Run `pnpm db:generate` and commit the result.");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Migrations are current.");
