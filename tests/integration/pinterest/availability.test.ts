import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { NotFoundError } from "../../../src/server/dal/errors";
import * as connect from "../../../src/server/services/connect";
import { closeDb } from "../../helpers/db";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Pinterest availability on Accounts", () => {
  it("is not configured without the variables, with a setup-guide link and no connect action", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "");
    const env = await postsEnv();
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "pinterest");
    expect(group).toMatchObject({ configured: false, available: false, unavailable: null });
    expect(group?.setupDoc).toMatch(/pinterest-setup/);
  });

  it("refuses a hand-made start request server-side when not configured", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "");
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const err = await connect.startOAuthConnect(env.scope, { groupKey: "pinterest" }, session).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("is unavailable under the test suite's http://localhost callback address, with Pinterest's reason and the guide link", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "pinterest-client-id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "pinterest-client-secret-value-0");
    const env = await postsEnv();
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "pinterest");
    expect(group).toMatchObject({
      configured: true,
      available: false,
      unavailable: { reason: "Pinterest needs an HTTPS callback address that is not localhost." },
    });
    expect(group?.unavailable?.doc).toMatch(/pinterest-setup\/?#callback-address/);
  });
});
