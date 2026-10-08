import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PublishContext, SocialProvider, StepResult } from "../../../src/providers/types";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { png } from "../../helpers/images";
import { instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";

// A throwaway provider whose second step runs after a publishing step was sent (G23). No Meta code.
const script = {
  advance: async (_ctx: PublishContext): Promise<StepResult> => ({ kind: "done", externalId: "x" }),
};
let advanceCalls = 0;

registerTestProvider({
  ...instagramLikeProvider,
  key: "after-publish",
  displayName: "After publish",
  stepFor: (state) => (state === null ? { name: "send", mayPublish: true } : { name: "check", mayPublish: false, afterPublish: true }),
  advance: async (ctx: PublishContext) => {
    advanceCalls++;
    return script.advance(ctx);
  },
} as SocialProvider);

const defaults = { ...script };
beforeEach(async () => {
  await parkAllDueTargets();
  Object.assign(script, defaults);
  advanceCalls = 0;
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const expired = () => new Date(Date.now() - 60_000);
const SENT = { status: "publishing", stepState: { sent: true }, firstStepAt: expired(), publishStartedAt: expired() } as const;
const SUFFIX = "The post may already be live; check before retrying.";

async function setup(opts: { withMedia?: boolean; patch?: Record<string, unknown> } = {}) {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const project = await createProject();
  const repos = createSchedulingRepos(testDb(), project.id);
  const account = await createMockAccount(project.id, {}, { providerKey: "after-publish", displayName: "Docket Page" });
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: "old-token" }), null);
  const { post, target } = await createDueTarget(project.id, account.id, { patch: { ...SENT, ...opts.patch } });
  let assetId: string | null = null;
  if (opts.withMedia) {
    const body = await png(1000, 1000);
    const key = `projects/${project.id}/media/a/original.png`;
    await storage.put(key, body, "image/png");
    const asset = await repos.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: body.length,
      width: 1000,
      height: 1000,
    });
    await repos.posts.setMedia(post.id, [asset.id]);
    assetId = asset.id;
  }
  return { repos, account, target, assetId };
}

describe("steps after publishing (G23)", () => {
  it("media deleted after the post was sent → ambiguous, no provider call", async () => {
    const { repos, target, assetId } = await setup({ withMedia: true });
    await repos.media.softDelete(assetId!, new Date());
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ ambiguous: 1, failed: 0 });
    expect(advanceCalls).toBe(0);
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "ambiguous", nextAttemptAt: null });
    expect(row?.lastError).toContain(SUFFIX);
  });

  it("provider timeouts to the attempt cap → ambiguous", async () => {
    const { repos, target } = await setup({ patch: { attemptCount: 99 } });
    script.advance = async () => {
      throw new Error("The provider call timed out.");
    };
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ ambiguous: 1, failed: 0 });
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "ambiguous" });
    expect(row?.lastError).toContain(SUFFIX);
  });

  it("stale leases to the attempt cap → ambiguous", async () => {
    const { repos, target } = await setup({
      patch: { attemptCount: 99, leaseOwner: randomUUID(), leaseUntil: expired(), inFlightStep: "check", inFlightMayPublish: false },
    });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ recovered: 1, ambiguous: 1, failed: 0 });
    expect(advanceCalls).toBe(0);
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "ambiguous", nextAttemptAt: null });
    expect(row?.lastError).toBe("Publishing was interrupted too many times after the post was sent; check before retrying.");
  });

  it("an account flagged needs_reauth by another target → ambiguous, no provider call", async () => {
    const { repos, account, target } = await setup();
    await testDb().update(socialAccounts).set({ status: "needs_reauth" }).where(and(eq(socialAccounts.projectId, account.projectId), eq(socialAccounts.id, account.id)));
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ ambiguous: 1, failed: 0 });
    expect(advanceCalls).toBe(0);
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "ambiguous", nextAttemptAt: null });
    expect(row?.lastError).toContain(SUFFIX);
  });

  it("maxPublishDurationMs exceeded → ambiguous, no provider call", async () => {
    const { repos, target } = await setup();
    const tick = await runTick({ config: { maxPublishDurationMs: 1000 } });
    expect(tick.publishing.counts).toMatchObject({ ambiguous: 1, failed: 0 });
    expect(advanceCalls).toBe(0);
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "ambiguous", nextAttemptAt: null });
    expect(row?.lastError).toContain(SUFFIX);
  });

  it("a provider fatal_error still fails", async () => {
    const { repos, target } = await setup();
    script.advance = async () => ({ kind: "fatal_error", error: "Facebook says it failed." });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ failed: 1, ambiguous: 0 });
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "failed" });
  });

  it("ambiguous with credentialsInvalid flags the account, emits once, and stays ambiguous", async () => {
    const { repos, account, target } = await setup();
    script.advance = async () => ({ kind: "ambiguous", error: "Session has expired (code 190).", credentialsInvalid: true });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ ambiguous: 1, failed: 0 });
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "ambiguous", nextAttemptAt: null });
    expect(row?.lastError).toBe("Session has expired (code 190). Reconnect Docket Page to publish again.");
    expect(await repos.accounts.get(account.id)).toMatchObject({ status: "needs_reauth", lastError: "Session has expired (code 190)." });
    expect(await repos.accounts.listNeedingReauth()).toEqual([expect.objectContaining({ id: account.id })]);
    expect(advanceCalls).toBe(1);
    await runTick({ config: {} });
    expect(advanceCalls).toBe(1);
  });
});
