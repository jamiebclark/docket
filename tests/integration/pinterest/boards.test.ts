import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountDetailsCache, readAccountDetails } from "../../../src/server/services/account-details";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { boardsPage, createFakePinterest } from "../../helpers/fake-pinterest";
import { postsEnv } from "../../helpers/posts-env";

const BOARDS = "/v5/boards";
const fake = createFakePinterest();

beforeEach(() => {
  vi.stubEnv("PINTEREST_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("PINTEREST_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  clearAccountDetailsCache();
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "pinterest",
    externalAccountId: "pinterest-user-1",
    displayName: "Ada's Studio",
    settings: {},
    credentials: {
      v: 1,
      accessToken: "PIN-ACCESS-0123456789",
      refreshToken: "PIN-REFRESH-0123456789",
      accessExpiresAt: Date.now() + 20 * 86_400_000,
      refreshIssuedAt: Date.now(),
      refreshExpiresAt: Date.now() + 60 * 86_400_000,
      refreshExpiryEstimated: false,
    },
  });
  return { env, account };
}

describe("Pinterest boards through readAccountDetails", () => {
  it("reads a single page of boards", async () => {
    const { env, account } = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }, { id: "b2", name: "Travel" }]) });
    const result = await readAccountDetails(env.scope, account.id);
    expect(result).toMatchObject({ ok: true, details: { boards: [{ id: "b1", name: "Recipes" }, { id: "b2", name: "Travel" }], truncated: false } });
    expect(fake.callsTo("GET", BOARDS)).toHaveLength(1);
  });

  it("follows bookmark across two pages (300 boards)", async () => {
    const { env, account } = await setup();
    const page1 = Array.from({ length: 250 }, (_, i) => ({ id: `b${i}`, name: `Board ${i}` }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({ id: `b${250 + i}`, name: `Board ${250 + i}` }));
    fake.on("GET", BOARDS, [{ kind: "ok", body: boardsPage(page1, "bm1") }, { kind: "ok", body: boardsPage(page2) }]);
    const result = await readAccountDetails(env.scope, account.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect((result.details as { boards: unknown[] }).boards).toHaveLength(300);
    expect(fake.callsTo("GET", BOARDS)).toHaveLength(2);
  });

  it("reuses the details for 60 seconds, and fresh reads again", async () => {
    const { env, account } = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }]) });
    await readAccountDetails(env.scope, account.id);
    await readAccountDetails(env.scope, account.id);
    expect(fake.callsTo("GET", BOARDS)).toHaveLength(1);
    await readAccountDetails(env.scope, account.id, { fresh: true });
    expect(fake.callsTo("GET", BOARDS)).toHaveLength(2);
  });
});
