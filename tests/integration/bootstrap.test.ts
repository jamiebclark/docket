import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { count } from "drizzle-orm";
import { SetupUnavailableError } from "../../src/server/dal/errors";
import { bootstrapFirstUser, isSetupAvailable } from "../../src/server/dal/install";
import { user } from "../../src/server/db/schema";
import { runStartup } from "../../src/server/startup";
import { createThrowawayDb } from "../helpers/db";

let tmp: Awaited<ReturnType<typeof createThrowawayDb>>;
const PASSWORD = "correct-horse-battery";

beforeAll(async () => {
  tmp = await createThrowawayDb();
});
afterAll(async () => {
  await tmp.drop();
});

async function userCount(): Promise<number> {
  const [row] = await tmp.db.select({ n: count() }).from(user);
  return row?.n ?? 0;
}

describe("first-run bootstrap", () => {
  it("is available on an empty install", async () => {
    expect(await isSetupAvailable(tmp.db)).toBe(true);
  });

  it("lets exactly one of two concurrent attempts win", async () => {
    const attempt = (email: string) =>
      bootstrapFirstUser({ name: "Admin", email, password: PASSWORD }, tmp.db);
    const results = await Promise.allSettled([attempt("one@example.com"), attempt("two@example.com")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(SetupUnavailableError);
    expect(await userCount()).toBe(1);
    expect(await isSetupAvailable(tmp.db)).toBe(false);
  });

  it("env bootstrap is skipped when accounts exist and does not reset the password", async () => {
    const logs: string[] = [];
    await runStartup({
      env: envFor(tmp.url, { BOOTSTRAP_ADMIN_EMAIL: "three@example.com", BOOTSTRAP_ADMIN_PASSWORD: "another-long-password" }),
      log: (m) => logs.push(m),
      migrate: async () => {},
      bootstrap: (input) => bootstrapFirstUser(input, tmp.db),
    });
    expect(logs.join("\n")).toContain("skipped (accounts exist)");
    expect(await userCount()).toBe(1);
  });

  it("an invalid bootstrap password fails startup naming the variable", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    await expect(
      runStartup({
        env: envFor(tmp.url, { BOOTSTRAP_ADMIN_EMAIL: "x@example.com", BOOTSTRAP_ADMIN_PASSWORD: "short" }),
        exit: (code) => {
          throw new Error(`exit ${code}`);
        },
      }),
    ).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("BOOTSTRAP_ADMIN_PASSWORD");
    expect(errors.join("\n")).not.toContain("short\n");
    vi.restoreAllMocks();
  });
});

describe("bootstrapped account", () => {
  it("can sign in through Better Auth", async () => {
    // Uses the shared test database (the one Better Auth is bound to); cleaned up afterwards.
    const { getAuth } = await import("../../src/server/auth/auth");
    const { getDb } = await import("../../src/server/db/client");
    const { installState } = await import("../../src/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    // Files run serially against one database; first-run needs it empty of accounts.
    await db.delete(user);
    await db.delete(installState);
    const { userId } = await bootstrapFirstUser({ name: "Boss", email: "Boss@Example.com", password: PASSWORD }, db);
    try {
      const res = await getAuth().api.signInEmail({
        body: { email: "boss@example.com", password: PASSWORD },
        headers: new Headers(),
      });
      expect(res.user.email).toBe("boss@example.com");
    } finally {
      await db.delete(user).where(eq(user.id, userId));
      await db.delete(installState);
    }
  });
});

function envFor(url: string, extra: Record<string, string>): Record<string, string> {
  return {
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: "test-secret-not-real-0123456789abcdef0123456789",
    BETTER_AUTH_URL: "http://localhost:3000",
    CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ...extra,
  };
}
