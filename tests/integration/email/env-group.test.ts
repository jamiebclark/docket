import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseEnv } from "../../../src/server/env";
import { getMailer, setMailerForTests } from "../../../src/server/mail";
import { runEmailDeliveries } from "../../../src/server/scheduler/email";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { clearRecordedQueries, getRecordedQueries } from "../../setup/scope-recorder";
import { closeDb } from "../../helpers/db";

const key = randomBytes(32).toString("base64");
const base = {
  DATABASE_URL: "postgres://u:pw-secret@localhost:5432/docket",
  BETTER_AUTH_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  CREDENTIALS_ENCRYPTION_KEY: key,
};

const FULL_GROUP = {
  SMTP_HOST: "smtp.example.com",
  SMTP_FROM: "docket@example.com",
};

function issues(src: Record<string, string | undefined>) {
  const r = parseEnv(src);
  if (r.ok) throw new Error("expected issues");
  return r.issues;
}

afterAll(closeDb);

describe("SMTP env group", () => {
  it("accepts nothing set, email off", () => {
    const r = parseEnv(base);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.env.smtp).toBeNull();
  });

  it("accepts the full group", () => {
    const r = parseEnv({ ...base, ...FULL_GROUP });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.env.smtp).toMatchObject({ host: FULL_GROUP.SMTP_HOST, from: FULL_GROUP.SMTP_FROM });
  });

  it.each(Object.keys(FULL_GROUP))("names %s when it is the only group member missing", (name) => {
    const partial: Record<string, string | undefined> = { ...base, ...FULL_GROUP, [name]: undefined };
    expect(issues(partial).map((i) => i.name)).toContain(name);
  });

  it.each(["SMTP_USER", "SMTP_PASSWORD", "SMTP_PORT", "SMTP_SECURITY", "SMTP_FROM_NAME"])(
    "reports %s set without the group, pointing at SMTP_HOST and SMTP_FROM",
    (satellite) => {
      expect(issues({ ...base, [satellite]: "x" })).toEqual([
        { name: satellite, reason: "set SMTP_HOST and SMTP_FROM to enable email" },
      ]);
    },
  );

  it("requires SMTP_USER and SMTP_PASSWORD together, in either direction", () => {
    expect(issues({ ...base, ...FULL_GROUP, SMTP_USER: "u" }).map((i) => i.name)).toContain("SMTP_PASSWORD");
    expect(issues({ ...base, ...FULL_GROUP, SMTP_PASSWORD: "p" }).map((i) => i.name)).toContain("SMTP_USER");
  });

  it("accepts neither credential (unauthenticated relay)", () => {
    const r = parseEnv({ ...base, ...FULL_GROUP });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.env.smtp?.user).toBeUndefined();
    expect(r.env.smtp?.password).toBeUndefined();
  });

  it("accepts both credentials together", () => {
    const r = parseEnv({ ...base, ...FULL_GROUP, SMTP_USER: "u", SMTP_PASSWORD: "p" });
    expect(r.ok).toBe(true);
  });

  it("never echoes a value, even in a quoted-address refusal", () => {
    const text = JSON.stringify(
      issues({ ...base, ...FULL_GROUP, SMTP_HOST: "has whitespace", SMTP_FROM: "not-an-address", SMTP_PORT: "999999" }),
    );
    for (const v of ["has whitespace", "not-an-address", "999999"]) {
      expect(text).not.toContain(v);
    }
  });

  describe("with nothing set", () => {
    afterEach(() => {
      setMailerForTests(undefined);
    });

    it("offers no mailer", () => {
      expect(getMailer()).toBeNull();
    });

    it("attempts no tick work — zero statements", async () => {
      clearRecordedQueries();
      const config: SchedulerConfig = {
        timeBudgetMs: 60_000,
        maxItems: 10,
        leaseMs: 60_000,
        providerTimeoutMs: 5_000,
        maxAttempts: 5,
        backoffBaseMs: 1_000,
        backoffMaxMs: 60_000,
        maxPublishDurationMs: 3_600_000,
        refreshWindowMs: 7_200_000,
        refreshMaxAccounts: 5,
        batchSize: 4,
      };
      const counts = await runEmailDeliveries({ config, tickId: "test", startedAt: new Date() });
      expect(counts).toMatchObject({ claimed: 0, sent: 0, recovered: 0, purged: 0 });
      expect(getRecordedQueries()).toHaveLength(0);
    });
  });
});
