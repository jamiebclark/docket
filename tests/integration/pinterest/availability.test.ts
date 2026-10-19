import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { and, eq } from "drizzle-orm";
import { NotFoundError } from "../../../src/server/dal/errors";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates, socialAccounts } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import * as connect from "../../../src/server/services/connect";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { createFakePinterest } from "../../helpers/fake-pinterest";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);
afterEach(() => {
  vi.unstubAllEnvs();
});

// A tick claims across every project and is `limit`-bounded, so rows left by other files on this
// worker's database fill this tick's claims and its own target is never reached - which shows up
// as the poll-state row simply not existing. Measured at 1 of 20 repetitions in flake-hunt run
// 39195627319, failing as "expected undefined to match object".
beforeEach(parkAllDueTargets);

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

describe("PINNER_DATA_ACCESS_DENIED backs off rather than retrying tightly and does not flag the account (FR-031)", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");

  it("the target's next poll is pushed into the future and the account's status stays active", async () => {
    const fake = createFakePinterest().install();
    try {
      const ctx = await createProjectWithMembers();
      const repos = forSchedulerProject(ctx.project.id);
      const account = await repos.accounts.upsertConnected({
        providerKey: "pinterest",
        displayName: "Ada's Pinterest",
        externalAccountId: "availability-user-1",
        settings: {},
        credentialsEncrypted: null,
        credentialsExpiresAt: null,
        connectedByUserId: null,
        grantedScopes: ["user_accounts:read", "boards:read", "pins:write", "pins:read"],
      });
      const credentials = {
        v: 1,
        accessToken: "AVAILABILITY-ACCESS",
        refreshToken: "AVAILABILITY-REFRESH",
        accessExpiresAt: NOW.getTime() + 2_592_000_000,
        refreshIssuedAt: NOW.getTime(),
        refreshExpiresAt: NOW.getTime() + 5_184_000_000,
        refreshExpiryEstimated: false,
      };
      await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, credentials), new Date(credentials.refreshExpiresAt));

      const post = await repos.posts.insert({ baseText: "Hello" });
      const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
      await repos.targets.update(target!.id, { status: "published", externalId: "availability-pin-1", publishedAt: NOW });

      fake.on("GET", "/v5/pins/availability-pin-1/analytics", { kind: "error", status: 403, message: "PINNER_DATA_ACCESS_DENIED" });
      fake.on("GET", "/v5/user_account", { kind: "ok", body: { id: "availability-user-1", follower_count: 1, monthly_views: 1 } });

      await runTick(tickConfig());

      const [poll] = await getDb()
        .select()
        .from(postMetricPollStates)
        .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, target!.id)));
      expect(poll).toMatchObject({ unavailableReason: expect.stringContaining("business account"), frozenAt: null });
      expect(poll!.nextPollAt).not.toBeNull();
      expect(poll!.nextPollAt!.getTime()).toBeGreaterThan(Date.now());

      const [row] = await getDb()
        .select()
        .from(socialAccounts)
        .where(and(eq(socialAccounts.projectId, ctx.project.id), eq(socialAccounts.id, account.id)));
      expect(row!.status).toBe("active");
    } finally {
      fake.uninstall();
    }
  });
});
