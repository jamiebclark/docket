import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityEvents } from "../../../src/server/db/schema/activity";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePinterest } from "../../helpers/fake-pinterest";
import { PIN_ACCESS, PIN_REFRESH, pinterestPublishSetup } from "../../helpers/pinterest-publish";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

const PINS = "/v5/pins";
/** What a hostile or careless Pinterest might echo back in a reply. */
const ECHO = `token=${PIN_ACCESS} refresh=${PIN_REFRESH}`;
const SECRETS = [PIN_ACCESS, PIN_REFRESH];

let fake: ReturnType<typeof createFakePinterest>;
let storage: MemoryStorage;
let logs: string[];

beforeEach(async () => {
  await parkAllDueTargets();
  vi.stubEnv("PINTEREST_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("PINTEREST_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  fake = createFakePinterest().install();
  fake.secrets(PIN_ACCESS, PIN_REFRESH);
  storage = createMemoryStorage();
  setStorageForTests(storage);
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

function expectClean(label: string, text: string) {
  for (const secret of SECRETS) expect(text.includes(secret), `${label} leaks ${secret.slice(0, 8)}…`).toBe(false);
}

async function dump(projectId: string) {
  const attempts = await testDb().select().from(publishAttempts).where(eq(publishAttempts.projectId, projectId));
  const activity = (await testDb().select().from(activityEvents).where(eq(activityEvents.projectId, projectId))).map(({ seq: _seq, ...rest }) => rest);
  return JSON.stringify([attempts, activity]);
}

describe("Pinterest no-secrets rule (constitution VII, FR-008)", () => {
  it("keeps tokens out of every record when Pinterest echoes them in a refusal", async () => {
    fake.on("POST", PINS, { kind: "error", status: 400, message: ECHO });
    const s = await pinterestPublishSetup(storage);
    await s.tick();

    const row = await s.row();
    expect(row.status).toBe("failed");
    const text = `${JSON.stringify(row)}\n${await dump(s.projectId)}\n${logs.join("\n")}`;
    expectClean("persisted rows", text);
    expectClean("console", logs.join("\n"));
  });

  it("keeps tokens out of a 404, 403 and an ambiguous 5xx reply", async () => {
    for (const status of [404, 403, 503]) {
      fake.reset();
      fake.install();
      fake.secrets(PIN_ACCESS, PIN_REFRESH);
      fake.on("POST", PINS, { kind: "error", status, message: ECHO });
      const s = await pinterestPublishSetup(storage);
      await s.tick();

      const row = await s.row();
      expect(["failed", "ambiguous"]).toContain(row.status);
      const text = `${JSON.stringify(row)}\n${await dump(s.projectId)}\n${logs.join("\n")}`;
      expectClean(`status ${status}`, text);
    }
  });

  it("stores credentials only as ciphertext", async () => {
    fake.on("POST", PINS, { kind: "ok", body: { id: "pin-1" } });
    const s = await pinterestPublishSetup(storage);
    await s.tick();

    const [account] = await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, s.projectId), eq(socialAccounts.id, s.accountId)));
    const ciphertext = account!.credentialsEncrypted as unknown as string;
    expect(ciphertext).toBeTruthy();
    expect(String(ciphertext)).not.toContain(PIN_ACCESS);
    expect(String(ciphertext)).not.toContain(PIN_REFRESH);
  });
});
