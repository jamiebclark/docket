import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { blueskyLikeProvider, registerTestProvider } from "../../../tests/helpers/provider-fixtures";
// eslint-disable-next-line no-restricted-imports -- test teardown only closes the pool
import { closeDb } from "../../../tests/helpers/db";
import { postsEnv } from "../../../tests/helpers/posts-env";
import type { SocialProvider } from "../../providers/types";
import { clearAccountDetailsCache, readAccountDetails } from "./account-details";
import * as accounts from "./accounts";

const reads: unknown[] = [];
let mode: "ok" | "leak" | "throw" = "ok";

const provider = registerTestProvider({
  ...blueskyLikeProvider,
  key: "details-test",
  displayName: "Details test",
  needsRefresh: (credentials) => (credentials as { stale?: boolean }).stale === true,
  refreshCredentials: async () => ({ ok: true, credentials: { token: "fresh-token-value", stale: false }, expiresAt: null }),
  accountDetails: {
    schema: z.object({ nickname: z.string() }),
    read: async ({ credentials }) => {
      reads.push(credentials);
      if (mode === "throw") throw new Error("boom");
      if (mode === "leak") return { ok: false, transient: true, message: `failed for ${(credentials as { token: string }).token}` };
      return { ok: true, details: { nickname: "Ada" } };
    },
  },
} as SocialProvider);

beforeEach(() => {
  reads.length = 0;
  mode = "ok";
  clearAccountDetailsCache();
});
afterAll(closeDb);

async function setup(credentials: unknown = { token: "secret-token-value", stale: false }) {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: provider.key,
    externalAccountId: `d-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "Ada",
    settings: {},
    credentials,
  });
  return { env, account };
}

describe("readAccountDetails (G26)", () => {
  it("returns the parsed details and reuses them within 60 seconds", async () => {
    const { env, account } = await setup();
    expect(await readAccountDetails(env.scope, account.id)).toEqual({ ok: true, details: { nickname: "Ada" } });
    expect(await readAccountDetails(env.scope, account.id)).toEqual({ ok: true, details: { nickname: "Ada" } });
    expect(reads).toHaveLength(1);
    await readAccountDetails(env.scope, account.id, { fresh: true });
    expect(reads).toHaveLength(2);
  });

  it("renews stale credentials before reading", async () => {
    const { env, account } = await setup({ token: "old-token-value", stale: true });
    expect((await readAccountDetails(env.scope, account.id)).ok).toBe(true);
    expect(reads[0]).toMatchObject({ token: "fresh-token-value" });
  });

  it("scrubs secrets from a failure message and does not cache failures", async () => {
    const { env, account } = await setup();
    mode = "leak";
    const failed = await readAccountDetails(env.scope, account.id);
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("secret-token-value");
    mode = "ok";
    expect((await readAccountDetails(env.scope, account.id)).ok).toBe(true);
  });

  it("treats a thrown read as a transient failure with a plain message", async () => {
    const { env, account } = await setup();
    mode = "throw";
    expect(await readAccountDetails(env.scope, account.id)).toEqual({
      ok: false,
      transient: true,
      message: "Couldn't load this Details test account's options.",
    });
  });

  it("never carries credentials to the caller", async () => {
    const { env, account } = await setup();
    const result = await readAccountDetails(env.scope, account.id);
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
  });
});
