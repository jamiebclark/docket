/**
 * Sets an account's password from the command line, for when nobody can sign in.
 *
 * Docket had no supported way out of a lockout. `bootstrapFirstUser` only runs on an install with no
 * accounts, password reset needs working email *and* a working path back into the app, and
 * `/account` needs a session. On 2026-10-17 a stale Cloudflare connector broke every POST through the
 * tunnel, which took sign-in and reset down together; recovery meant hand-generating a scrypt hash and
 * hand-writing SQL, and the first attempt silently matched zero rows because it filtered on the wrong
 * address. This script exists so that is never the recovery path again.
 *
 *   pnpm set-password --email you@example.com                 prompts for the new password
 *   pnpm set-password --email you@example.com --password ...  non-interactive (shell history!)
 *   pnpm set-password --list                                  show the accounts that exist
 *
 * It writes the same `account` row shape sign-in reads: `provider_id = 'credential'` with
 * `account_id = user_id`, which is what `signInEmail` matches on. A row whose `account_id` does not
 * equal the user id is invisible to sign-in while still looking correct in a casual query.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { getDb, closeDb } from "../src/server/db/client";
import { runCrossProject } from "../src/server/db/cross-project";
import { account, user } from "../src/server/db/schema/auth";
import { PASSWORD_MAX, PASSWORD_MIN } from "../src/lib/validation/password";
import { getEnv } from "../src/server/env";

/**
 * Which database this is about to change, by name only — never the credentials.
 *
 * Printed before anything else because an environment variable already set in the shell beats
 * `--env-file`, so this can silently address a different database than `.env` names. That bit during
 * development: the shell exported a `*_test` URL and the tool truthfully reported "no accounts" for a
 * database nobody meant to ask about.
 */
function databaseName(): string {
  try {
    return decodeURIComponent(new URL(getEnv().DATABASE_URL).pathname.slice(1)) || "(unknown)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const db = getDb();
  console.log(`database: ${databaseName()}`);

  if (has("list")) {
    const rows = await runCrossProject("set-password: list accounts", () =>
      db.select({ email: user.email, name: user.name, id: user.id }).from(user).orderBy(user.createdAt),
    );
    if (rows.length === 0) {
      console.log("No accounts exist. Use BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD instead.");
      return 0;
    }
    for (const r of rows) console.log(`${r.email}\t${r.name}\t${r.id}`);
    return 0;
  }

  const email = arg("email")?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: pnpm set-password --email <address> [--password <value>]   (or --list)");
    return 2;
  }

  // Resolve the account first, and say plainly when there is no match. The failure that cost hours was
  // an UPDATE that matched zero rows and reported success.
  const found = await runCrossProject("set-password: find user", () =>
    db.select({ id: user.id, email: user.email }).from(user).where(eq(user.email, email)).limit(1),
  );
  const target = found[0];
  if (!target) {
    console.error(`No account with that address. Run "pnpm set-password --list" to see what exists.`);
    return 1;
  }

  let password = arg("password");
  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout });
    password = await rl.question(`New password for ${target.email}: `);
    rl.close();
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    console.error(`Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`);
    return 1;
  }

  const passwordHash = await hashPassword(password);
  const written = await runCrossProject("set-password: write credential", async () =>
    db.transaction(async (tx) => {
      // Collapse to exactly one credential row. Better Auth's reset path looks one up by user id alone
      // while sign-in additionally requires `account_id = user_id`, so the two can disagree and leave a
      // row that resets fine and never signs in.
      await tx.delete(account).where(and(eq(account.userId, target.id), eq(account.providerId, "credential")));
      const rows = await tx
        .insert(account)
        .values({ userId: target.id, accountId: target.id, providerId: "credential", password: passwordHash })
        .returning({ id: account.id });
      return rows.length;
    }),
  );

  // Always report what was actually touched: "it ran" is not the same as "it changed something".
  console.log(`Set the password for ${target.email} (${written} credential row written).`);
  console.log("Every existing session stays valid; sign in and change it from /account if it was shared.");
  return written === 1 ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(`set-password failed: ${error instanceof Error ? error.message : "unknown error"}`);
    await closeDb();
    process.exit(1);
  });
