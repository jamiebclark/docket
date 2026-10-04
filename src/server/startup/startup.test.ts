import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupUnavailableError } from "../dal/errors";
import * as registry from "../../providers/registry";
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

  it("reports a core issue and a connect-group issue together, without values", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    const group = {
      key: "fake",
      displayName: "Fake",
      environment: {
        variables: [{ name: "FAKE_APP_SECRET", secret: true, required: true }],
        issues: (src: Record<string, string | undefined>) =>
          src.FAKE_APP_SECRET ? [{ name: "FAKE_APP_SECRET", reason: "is too short" }] : [],
        configured: () => false,
      },
    };
    vi.spyOn(registry, "listConnectGroups").mockReturnValue([{ group: group as never, providers: [] }]);
    const { d } = deps({
      env: { ...GOOD_ENV, BETTER_AUTH_SECRET: "short-SECRETVALUE", FAKE_APP_SECRET: "GROUPSECRETVALUE" },
    });
    await expect(runStartup(d)).rejects.toMatchObject({ code: 1 });
    const out = errors.join("\n");
    expect(out).toContain("BETTER_AUTH_SECRET");
    expect(out).toContain("FAKE_APP_SECRET");
    expect(out).not.toContain("SECRETVALUE");
    expect(d.migrate).not.toHaveBeenCalled();
  });

  it("exits 1 for a group issue alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const group = {
      key: "fake",
      displayName: "Fake",
      environment: { variables: [], issues: () => [{ name: "FAKE_ID", reason: "is required" }], configured: () => false },
    };
    vi.spyOn(registry, "listConnectGroups").mockReturnValue([{ group: group as never, providers: [] }]);
    const { d } = deps();
    await expect(runStartup(d)).rejects.toMatchObject({ code: 1 });
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

  it("logs a disabled-generation line and continues when the LLM settings are unset or incomplete", async () => {
    const unset = deps();
    await expect(runStartup(unset.d)).resolves.toBeUndefined();
    expect(unset.logs.join("\n")).toContain("Docket: generation disabled (LLM_PROVIDER: not set; generation is disabled)");

    const partial = deps({ env: { ...GOOD_ENV, LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-SECRETVALUE" } });
    await expect(runStartup(partial.d)).resolves.toBeUndefined();
    const out = partial.logs.join("\n");
    expect(out).toContain("generation disabled (LLM_MODEL: required when LLM_PROVIDER=openai)");
    expect(out).not.toContain("SECRETVALUE");
  });

  it("names an unknown provider and a missing Anthropic key, and keeps going", async () => {
    const unknown = deps({ env: { ...GOOD_ENV, LLM_PROVIDER: "gemini" } });
    await expect(runStartup(unknown.d)).resolves.toBeUndefined();
    expect(unknown.logs.join("\n")).toContain("generation disabled (LLM_PROVIDER: must be openai or anthropic)");

    const noKey = deps({ env: { ...GOOD_ENV, LLM_PROVIDER: "anthropic", LLM_MODEL: "m" } });
    await expect(runStartup(noKey.d)).resolves.toBeUndefined();
    expect(noKey.logs.join("\n")).toContain("generation disabled (ANTHROPIC_API_KEY: required when LLM_PROVIDER=anthropic)");
  });

  it("logs nothing about generation when it is configured", async () => {
    const ok = deps({ env: { ...GOOD_ENV, LLM_PROVIDER: "openai", LLM_MODEL: "m", OPENAI_API_KEY: "sk-x" } });
    await runStartup(ok.d);
    expect(ok.logs.join("\n")).not.toContain("generation disabled");
  });
});
