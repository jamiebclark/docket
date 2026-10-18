import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { refreshPinterest } from "../../../src/providers/pinterest/refresh";
import { refreshTikTok } from "../../../src/providers/tiktok/refresh";
import { claimDueAccountMetricPolls, claimDuePostMetricPolls, type InsightsProviderRule } from "../../../src/server/dal/insights-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { applyRefreshResult } from "../../../src/server/scheduler/credentials";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createFakeTikTok, tokenReply } from "../../helpers/fake-tiktok";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(closeDb);

const NOW = new Date("2026-05-01T00:00:00Z");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function leased(projectId: string, grantedScopes: readonly string[] | undefined) {
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "mock",
    displayName: "Account",
    externalAccountId: `ext-${randomUUID()}`,
    settings: {},
    credentialsEncrypted: encryptCredentials(randomUUID(), { token: "old" }),
    credentialsExpiresAt: null,
    connectedByUserId: null,
    grantedScopes,
  });
  const token = randomUUID();
  const ciphertext = (await repos.accounts.getCredentialsCiphertext(account.id))!;
  await repos.accounts.acquireRefreshLease(account.id, token, { now: new Date(), leaseMs: 60_000, expectedCiphertext: ciphertext });
  return { repos, account, token };
}

describe("granted scopes through a refresh (FR-011, FR-028, US2-AS4/5)", () => {
  it("a refresh returning a token and no permission list leaves the stored value identical, including when it was []", async () => {
    const { project } = await createProjectWithMembers();
    const { repos, account, token } = await leased(project.id, []);

    const result = await applyRefreshResult(
      repos,
      account,
      token,
      { ok: true, credentials: { token: "new" }, expiresAt: null },
      [],
    );
    expect(result.kind).toBe("refreshed");

    const stored = await repos.accounts.get(account.id);
    expect(stored?.grantedScopes).toEqual([]);
  });

  it("a refresh reporting a list that drops the insight permission replaces the stored value, with no error", async () => {
    const { project } = await createProjectWithMembers();
    const { repos, account, token } = await leased(project.id, ["instagram_manage_insights", "instagram_basic"]);

    const result = await applyRefreshResult(
      repos,
      account,
      token,
      { ok: true, credentials: { token: "new" }, expiresAt: null, grantedScopes: ["instagram_basic"] },
      [],
    );
    expect(result.kind).toBe("refreshed");

    const stored = await repos.accounts.get(account.id);
    expect(stored?.grantedScopes).toEqual(["instagram_basic"]);
    expect(stored?.lastError).toBeNull();
    expect(stored?.status).toBe("active");
  });
});

describe("a renewed or narrowed grant does not go stale (US6, FR-056, FR-057)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("TikTok: a refresh reply narrowing scope drops the account surface from the next claim", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "tiktok",
      displayName: "Narrowed TikTok",
      externalAccountId: `ext-tiktok-${randomUUID()}`,
      settings: {},
      credentialsEncrypted: encryptCredentials(randomUUID(), {
        v: 1,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        accessExpiresAt: NOW.getTime() + 60_000,
        refreshIssuedAt: NOW.getTime() - 86_400_000,
        refreshExpiresAt: NOW.getTime() + 364 * 86_400_000,
        refreshExpiryEstimated: false,
        openId: "open-id-1",
      }),
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["video.list", "user.info.stats"],
    });
    const token = randomUUID();
    const ciphertext = (await repos.accounts.getCredentialsCiphertext(account.id))!;
    await repos.accounts.acquireRefreshLease(account.id, token, { now: NOW, leaseMs: 60_000, expectedCiphertext: ciphertext });

    vi.stubEnv("TIKTOK_CLIENT_KEY", "CLIENT-KEY");
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
    const fake = createFakeTikTok().install();
    let result;
    try {
      fake.on("POST", "/v2/oauth/token/", { kind: "ok", body: tokenReply({ access_token: "new-access", scope: "video.list" }) });
      result = await refreshTikTok({
        credentials: { v: 1, accessToken: "old-access", refreshToken: "old-refresh", accessExpiresAt: NOW.getTime() + 60_000, refreshIssuedAt: NOW.getTime() - 86_400_000, refreshExpiresAt: NOW.getTime() + 364 * 86_400_000, refreshExpiryEstimated: false, openId: "open-id-1" },
        now: NOW,
        signal: new AbortController().signal,
      });
    } finally {
      fake.uninstall();
    }
    if (!result.ok) throw new Error("refresh failed");
    expect(result.grantedScopes).toEqual(["video.list"]);

    await applyRefreshResult(repos, account, token, result, []);
    const stored = await repos.accounts.get(account.id);
    expect(stored?.grantedScopes).toEqual(["video.list"]);

    const rule: InsightsProviderRule = {
      providerKey: "tiktok",
      postScopes: ["video.list"],
      accountScopes: ["user.info.stats"],
      postIdSource: "publicPostId",
      missingPostId: { reason: "This post has no queryable public post id." },
      postMetricsDeclared: true,
      accountMetricsDeclared: true,
      ephemeralPostTypes: [],
    };
    const claimedAccounts = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers: [rule] });
    expect(claimedAccounts.some((c) => c.account.id === account.id)).toBe(false);
  });

  it("Pinterest: a refresh reply narrowing scope drops the post surface from the next claim", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "pinterest",
      displayName: "Narrowed Pinterest",
      externalAccountId: `ext-pinterest-${randomUUID()}`,
      settings: {},
      credentialsEncrypted: encryptCredentials(randomUUID(), {
        v: 1,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        accessExpiresAt: 1_000,
        refreshIssuedAt: 500,
        refreshExpiresAt: 2_000,
        refreshExpiryEstimated: false,
      }),
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["user_accounts:read", "boards:read", "pins:read"],
    });
    const token = randomUUID();
    const ciphertext = (await repos.accounts.getCredentialsCiphertext(account.id))!;
    await repos.accounts.acquireRefreshLease(account.id, token, { now: NOW, leaseMs: 60_000, expectedCiphertext: ciphertext });

    vi.stubEnv("PINTEREST_CLIENT_ID", "id");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "new-access", expires_in: 100, scope: "user_accounts:read,boards:read" })),
    );
    const result = await refreshPinterest({
      credentials: { v: 1, accessToken: "old-access", refreshToken: "old-refresh", accessExpiresAt: 1_000, refreshIssuedAt: 500, refreshExpiresAt: 2_000, refreshExpiryEstimated: false },
      now: NOW,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new Error("refresh failed");
    expect(result.grantedScopes).toEqual(["user_accounts:read", "boards:read"]);

    await applyRefreshResult(repos, account, token, result, []);
    const stored = await repos.accounts.get(account.id);
    expect(stored?.grantedScopes).toEqual(["user_accounts:read", "boards:read"]);

    const post = await repos.posts.insert({ baseText: "Hello" });
    const [postTarget] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(postTarget!.id, { status: "published", externalId: "ext-pin-1", publishedAt: NOW });

    const rule: InsightsProviderRule = {
      providerKey: "pinterest",
      postScopes: ["pins:read"],
      accountScopes: [],
      postIdSource: "externalId",
      missingPostId: null,
      postMetricsDeclared: true,
      accountMetricsDeclared: true,
      ephemeralPostTypes: [],
    };
    const claimedPosts = await claimDuePostMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
    expect(claimedPosts.some((c) => c.state.postTargetId === postTarget!.id)).toBe(false);
  });
});
