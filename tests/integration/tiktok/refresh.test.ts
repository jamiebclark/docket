import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VIDEO_EDIT } from "../../../src/lib/video/edit";
import { tiktokPostingSchema } from "../../../src/providers/tiktok/posting";
import { consentFingerprint } from "../../../src/server/services/posts/consent";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { runTick } from "../../../src/server/scheduler";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { decryptCredentials, encryptCredentials } from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { clearRecordedQueries } from "../../setup/scope-recorder";
import { createFakeTikTok, tokenReply } from "../../helpers/fake-tiktok";
import { createVideoAsset } from "../../helpers/factories";
import { createDraftPost, parkAllDueTargets } from "../../helpers/scheduling";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 72 * 3_600_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2030-01-01T00:00:00Z");
const OLD_ACCESS = "OLD-TT-ACCESS-0123456789";
const OLD_REFRESH = "OLD-TT-REFRESH-0123456789";
const TOKEN = "/v2/oauth/token/";

const fake = createFakeTikTok();

beforeEach(async () => {
  await parkAllDueTargets();
  // T0 is in 2030 and refresh is global: push every account other files left on this worker's
  // database past T0, so each case sees only the accounts it creates.
  await testDb().update(socialAccounts).set({ credentialsExpiresAt: new Date("2100-01-01T00:00:00Z") });
  clearRecordedQueries(); // deliberately cross-project test setup, not code under test
  vi.stubEnv("TIKTOK_CLIENT_KEY", "CLIENT-KEY");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  fake.reset();
  fake.install();
  fake.secrets(OLD_ACCESS, OLD_REFRESH);
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

/** A TikTok account whose refresh token expires `refreshExpiresInMs` after T0. */
async function setup(refreshExpiresInMs: number, accessExpiresInMs = 12 * HOUR) {
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "tiktok",
    displayName: "Ada (@ada)",
    externalAccountId: "open-id-1",
    settings: { username: "ada", nickname: "Ada" },
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const refreshExpiresAt = T0.getTime() + refreshExpiresInMs;
  const creds = {
    v: 1,
    accessToken: OLD_ACCESS,
    refreshToken: OLD_REFRESH,
    accessExpiresAt: T0.getTime() + accessExpiresInMs,
    refreshIssuedAt: refreshExpiresAt - 365 * DAY,
    refreshExpiresAt,
    refreshExpiryEstimated: false,
    openId: "open-id-1",
  };
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, creds), new Date(refreshExpiresAt));
  const row = async () =>
    (await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, account.id))))[0]!;
  const stored = async () => decryptCredentials(account.id, (await row()).credentialsEncrypted) as Record<string, unknown>;
  return { projectId, accountId: account.id, row, stored };
}

const refreshTick = (when: Date) => atTime(when, () => runTokenRefresh({ config: CONFIG, tickId: randomUUID(), startedAt: when }));

describe("TikTok token renewal through the scheduler", () => {
  it("renews an idle account inside the 72 h window and stores the rotated refresh token", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", refresh_expires_in: 31_536_000 }) });
    const s = await setup(2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 1, failed: 0, deferred: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
    expect(await s.stored()).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH", refreshIssuedAt: T0.getTime() });
    const after = await s.row();
    expect(after.status).toBe("active");
    expect(after.credentialsExpiresAt!.getTime()).toBe(T0.getTime() + 31_536_000_000);
  });

  it("keeps the old refresh token when the reply has none", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: { access_token: "NEW-ACCESS", expires_in: 86_400 } });
    const s = await setup(2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 1 });
    expect(await s.stored()).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: OLD_REFRESH });
  });

  it("leaves an account outside the window alone, whatever its access token's age", async () => {
    const s = await setup(200 * DAY, 10 * MINUTE);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 0, deferred: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(0);
    expect(await s.stored()).toMatchObject({ refreshToken: OLD_REFRESH });
  });

  it("flags needs_reauth on invalid_grant and keeps the old credentials", async () => {
    fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error: "invalid_grant" });
    const s = await setup(2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 1 });
    const after = await s.row();
    expect(after.status).toBe("needs_reauth");
    expect(after.lastError).toContain("invalid_grant");
    expect(after.lastError).not.toContain(OLD_REFRESH);
    expect(await s.stored()).toMatchObject({ refreshToken: OLD_REFRESH });
  });

  it.each([
    ["5xx", { kind: "http", status: 503 } as const],
    ["429", { kind: "http", status: 429, body: "{}", headers: { "retry-after": "900" } } as const],
  ])("%s: stays active and holds the lease until retryAt", async (_name, reply) => {
    fake.on("POST", TOKEN, reply);
    const s = await setup(2 * DAY);
    expect(await refreshTick(T0)).toMatchObject({ refreshed: 0, failed: 0, deferred: 1 });
    const after = await s.row();
    expect(after.status).toBe("active");
    expect(after.refreshLeaseUntil!.getTime()).toBeGreaterThan(T0.getTime() + 60_000);
    // Inside the hold nothing is retried.
    expect(await refreshTick(new Date(T0.getTime() + 30_000))).toMatchObject({ deferred: 0, refreshed: 0 });
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
  });
});

describe("TikTok renewal on the publish path", () => {
  it("renews an access token within 30 minutes of expiry before the step runs, and persists the rotation", async () => {
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH" }) });
    const now = Date.now() + 60_000;
    const s = await setup(200 * DAY, 0);
    // Re-base the access expiry on the real clock the tick will read.
    const creds = { ...(await s.stored()), accessExpiresAt: now + 10 * MINUTE, refreshExpiresAt: now + 200 * DAY, refreshIssuedAt: now - 165 * DAY };
    await forSchedulerProject(s.projectId).accounts.setCredentials(s.accountId, encryptCredentials(s.accountId, creds), new Date(now + 200 * DAY));
    // A video post with its posting values and consent, so it passes the first-step content and consent checks and the engine reaches credentials.
    const video = await createVideoAsset(s.projectId, { width: 1080, height: 1920, durationSeconds: 20 });
    const text = "needs a fresh token";
    const { post, targets } = await createDraftPost(s.projectId, { baseText: text, accountIds: [s.accountId], mediaIds: [video.id] });
    const repos = forSchedulerProject(s.projectId);
    const due = new Date(now - 60_000);
    const values = tiktokPostingSchema.parse({ privacy: "SELF_ONLY" });
    await repos.targets.update(targets[0]!.id, {
      status: "scheduled",
      scheduleKind: "explicit",
      scheduledAt: due,
      nextAttemptAt: due,
      postingFields: values,
      consentAt: new Date(now - 120_000),
      consentFingerprint: consentFingerprint({ text, mediaIds: [video.id], videoEdits: [{ mediaId: video.id, edit: DEFAULT_VIDEO_EDIT }], values, details: null }),
    });
    await repos.posts.setStatus(post.id, "scheduled");

    await atTime(new Date(now), () => runTick({ config: {} }));
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
    expect(fake.callsTo("POST", TOKEN)[0]!.fields).toMatchObject({ grant_type: "refresh_token", refresh_token: "[redacted]" });
    expect(await s.stored()).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH" });
    expect((await s.row()).status).toBe("active");
  });
});
