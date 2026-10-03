import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupUnavailableError } from "../dal/errors";
import { runStartup, type StartupDeps } from "./index";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const GOOD_ENV = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

function deps(over: Partial<StartupDeps> = {}) {
  const logs: string[] = [];
  const d: StartupDeps = {
    env: GOOD_ENV,
    exit: (code) => {
      throw new ExitCalled(code);
    },
    log: (m) => logs.push(m),
    migrate: vi.fn(async () => {}),
    bootstrap: vi.fn(async () => ({})),
    ...over,
  };
  return { d, logs };
}

afterEach(() => vi.restoreAllMocks());

describe("runStartup", () => {
  it("prints every offending variable name, none of the values, and exits 1", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    const { d } = deps({
      env: { ...GOOD_ENV, DATABASE_URL: "not-a-url-SECRETVALUE", BETTER_AUTH_SECRET: "short-SECRETVALUE" },
    });
    await expect(runStartup(d)).rejects.toMatchObject({ code: 1 });
    const out = errors.join("\n");
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("BETTER_AUTH_SECRET");
    expect(out).not.toContain("SECRETVALUE");
    expect(d.migrate).not.toHaveBeenCalled();
  });

  it("skips migration when MIGRATE_ON_START=false", async () => {
    const { d } = deps({ env: { ...GOOD_ENV, MIGRATE_ON_START: "false" } });
    await runStartup(d);
    expect(d.migrate).not.toHaveBeenCalled();
  });

  it("does not migrate again when scripts/prestart.mjs already did", async () => {
    const { d } = deps({ env: { ...GOOD_ENV, DOCKET_PREMIGRATED: "1" } });
    await runStartup(d);
    expect(d.migrate).not.toHaveBeenCalled();
  });

  it("migrates with DATABASE_URL_DIRECT when set", async () => {
    const direct = "postgres://u:p@localhost:5433/direct";
    const { d } = deps({ env: { ...GOOD_ENV, DATABASE_URL_DIRECT: direct } });
    await runStartup(d);
    expect(d.migrate).toHaveBeenCalledWith(direct);
  });

  it("logs a fixed message and exits 1 when migration fails", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    const { d } = deps({
      migrate: async () => {
        throw new Error("connect to postgres://u:hunter2@host failed");
      },
    });
    await expect(runStartup(d)).rejects.toMatchObject({ code: 1 });
    expect(errors.join("\n")).not.toContain("hunter2");
    expect(errors.join("\n")).toContain("migration failed");
  });

  it("bootstraps from env and never logs the password", async () => {
    const { d, logs } = deps({
      env: { ...GOOD_ENV, BOOTSTRAP_ADMIN_EMAIL: "a@example.com", BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery" },
    });
    await runStartup(d);
    expect(d.bootstrap).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("created");
    expect(logs.join("\n")).not.toContain("correct-horse-battery");
  });

  it("logs skipped when accounts already exist", async () => {
    const { d, logs } = deps({
      env: { ...GOOD_ENV, BOOTSTRAP_ADMIN_EMAIL: "a@example.com", BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery" },
      bootstrap: async () => {
        throw new SetupUnavailableError();
      },
    });
    await runStartup(d);
    expect(logs.join("\n")).toContain("skipped (accounts exist)");
  });
});
