import { describe, expect, it, vi } from "vitest";
import { migrationUrl, prestart } from "../../scripts/prestart.mjs";

const e = (v: Record<string, string>) => v as NodeJS.ProcessEnv;
const URL_A = "postgres://u:p@localhost:5432/db";

describe("scripts/prestart.mjs", () => {
  it("migrates with the direct URL before the server may start", async () => {
    const order: string[] = [];
    const env = e({ DATABASE_URL: URL_A, DATABASE_URL_DIRECT: "postgres://u:p@h/direct" });
    const ok = await prestart({
      env,
      migrate: async (u: string) => void order.push(`migrate:${u}`),
      log: (m: string) => void order.push(m),
    });
    expect(ok).toBe(true);
    expect(order[0]).toBe("migrate:postgres://u:p@h/direct");
    expect(env.DOCKET_PREMIGRATED).toBe("1");
  });

  it("returns false (caller exits 1) with a fixed message when migration fails", async () => {
    const errors: string[] = [];
    const ok = await prestart({
      env: e({ DATABASE_URL: URL_A }),
      migrate: async () => {
        throw new Error("connect postgres://u:hunter2@h failed");
      },
      error: (m: string) => void errors.push(m),
    });
    expect(ok).toBe(false);
    expect(errors.join()).toContain("migration failed. Not starting.");
    expect(errors.join()).not.toContain("hunter2");
  });

  it("skips when MIGRATE_ON_START=false or the URL is unusable", async () => {
    const migrate = vi.fn();
    expect(migrationUrl(e({ DATABASE_URL: URL_A, MIGRATE_ON_START: "false" }))).toBeNull();
    expect(migrationUrl(e({ DATABASE_URL: "nope" }))).toBeNull();
    expect(await prestart({ env: e({ DATABASE_URL: URL_A, MIGRATE_ON_START: "false" }), migrate })).toBe(true);
    expect(migrate).not.toHaveBeenCalled();
  });
});
