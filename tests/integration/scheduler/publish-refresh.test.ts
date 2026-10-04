import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PublishContext, RefreshResult, SocialProvider, StepResult } from "../../../src/providers/types";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { findProvider } from "../../../src/providers/registry";
import { refreshForPublish } from "../../../src/server/scheduler/credentials";
import { runTick } from "../../../src/server/scheduler";
import { decryptCredentials, encryptCredentials } from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 7_200_000,
  refreshMaxAccounts: 5, batchSize: 4,
};

interface Creds {
  token: string;
}

// The scripted provider: tests replace these hooks.
const script = {
  needs: (c: Creds): boolean => c.token === "old",
  refresh: async (): Promise<RefreshResult> => ({ ok: true, credentials: { token: "new" }, expiresAt: null }),
  advance: async (_ctx: PublishContext): Promise<StepResult> => ({ kind: "done", externalId: "x" }),
};
const OTHER = randomUUID();
let refreshCalls = 0;
let advanceSeen: { creds: Creds; stored: Creds }[] = [];
let storedReader: () => Promise<Creds> = async () => ({ token: "unset" });

registerTestProvider({
  ...blueskyLikeProvider,
  key: "scripted-refresh",
  displayName: "Scripted refresh",
  needsRefresh: (c: unknown) => script.needs(c as Creds),
  refreshCredentials: async () => {
    refreshCalls++;
    return script.refresh();
  },
  advance: async (ctx: PublishContext) => {
    advanceSeen.push({ creds: ctx.account.credentials as Creds, stored: await storedReader() });
    return script.advance(ctx);
  },
} as SocialProvider);

const defaults = { ...script };
beforeEach(async () => {
  await parkAllDueTargets();
  Object.assign(script, defaults);
  refreshCalls = 0;
  advanceSeen = [];
});
afterAll(closeDb);

async function setup() {
  const project = await createProject();
  const repos = forSchedulerProject(project.id);
  const account = await createMockAccount(project.id, {}, { providerKey: "scripted-refresh" });
  const store = async (c: Creds) => {
    await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, c), null);
  };
  await store({ token: "old" });
  const read = async () => decryptCredentials(account.id, await repos.accounts.getCredentialsCiphertext(account.id)) as Creds;
  storedReader = read;
  const { target } = await createDueTarget(project.id, account.id);
  const makeDue = () => repos.targets.update(target.id, { nextAttemptAt: new Date(Date.now() - 1000) });
  const outcomes = async () => (await repos.attempts.listForTarget(target.id)).map((a) => a.outcome);
  return { repos, account, target, store, read, makeDue, outcomes };
}

describe("publish-time refresh (G2, G3)", () => {
  it("proactive: persists the new credentials before advance sees them", async () => {
    const { repos, target } = await setup();
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ done: 1 });
    expect(refreshCalls).toBe(1);
    expect(advanceSeen).toEqual([{ creds: { token: "new" }, stored: { token: "new" } }]);
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "published" });
  });

  it("changed: reuses credentials another caller already rotated, with no second refresh", async () => {
    const { repos, account, store } = await setup();
    const stale = (await repos.accounts.getCredentialsCiphertext(account.id))!;
    await store({ token: "rotated-by-other" });
    const r = await refreshForPublish({
      projectId: account.projectId,
      account: (await repos.accounts.get(account.id))!,
      provider: findProvider("scripted-refresh")!,
      seenCiphertext: stale,
      config: CONFIG,
    });
    expect(r).toMatchObject({ kind: "changed", credentials: { token: "rotated-by-other" } });
    expect(refreshCalls).toBe(0);
  });

  it("busy: releases the target without counting an attempt, and the next tick publishes", async () => {
    const { repos, account, target, read, makeDue, outcomes } = await setup();
    const ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
    await repos.accounts.acquireRefreshLease(account.id, OTHER, {
      now: new Date(),
      leaseMs: 600_000,
      expectedCiphertext: ciphertext!,
    });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ released: 1, done: 0 });
    expect(advanceSeen).toHaveLength(0);
    expect(refreshCalls).toBe(0);
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "scheduled", attemptCount: 0, leaseOwner: null });
    expect((await outcomes()).filter((o) => o === "released")).toHaveLength(1);

    await repos.accounts.recordRefresh(account.id, OTHER, {});
    await makeDue();
    const next = await runTick({ config: {} });
    expect(next.publishing.counts).toMatchObject({ done: 1 });
    expect(await read()).toEqual({ token: "new" });
  });

  it("refused: flags the account needs_reauth, then the next tick fails the target as account_unavailable", async () => {
    const { repos, account, target, makeDue, outcomes } = await setup();
    script.refresh = async () => ({ ok: false, reason: "refresh token revoked" });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ released: 1, done: 0 });
    expect(advanceSeen).toHaveLength(0);
    expect(await repos.accounts.get(account.id)).toMatchObject({ status: "needs_reauth", lastError: "refresh token revoked" });

    await makeDue();
    const next = await runTick({ config: {} });
    expect(next.publishing.counts).toMatchObject({ failed: 1 });
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "failed" });
    expect(await outcomes()).toContain("account_unavailable");
  });

  it("transient: the target is retryable at retryAt and the account stays active", async () => {
    const { repos, account, target } = await setup();
    const retryAt = new Date(Date.now() + 10 * 60_000);
    script.refresh = async () => ({ ok: false, reason: "PDS unreachable", transient: true, retryAt });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ retried: 1, done: 0 });
    expect(advanceSeen).toHaveLength(0);
    const after = await repos.targets.get(target.id);
    expect(after).toMatchObject({ status: "scheduled" });
    expect(after!.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(retryAt.getTime());
    expect(await repos.accounts.get(account.id)).toMatchObject({ status: "active" });
    expect((await repos.accounts.get(account.id))!.lastError).toContain("PDS unreachable");
  });

  it("reactive: credentialsExpired is recorded as retryable, refreshed, and the next tick publishes once", async () => {
    const { repos, target, read, makeDue } = await setup();
    script.needs = () => false;
    script.advance = async (ctx) =>
      (ctx.account.credentials as Creds).token === "old"
        ? { kind: "retryable_error", error: "ExpiredToken", credentialsExpired: true }
        : { kind: "done", externalId: "x" };
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ retried: 1, done: 0 });
    expect(refreshCalls).toBe(1);
    expect(await read()).toEqual({ token: "new" });
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "scheduled", attemptCount: 1 });

    await makeDue();
    const next = await runTick({ config: {} });
    expect(next.publishing.counts).toMatchObject({ done: 1 });
    expect(advanceSeen.map((a) => a.creds.token)).toEqual(["old", "new"]);
    expect(refreshCalls).toBe(1);
  });

  it("budget: a refresh that would overrun the tick deadline releases instead", async () => {
    const { repos, target } = await setup();
    script.needs = (c) => {
      const until = Date.now() + 1_100; // burns the time the refresh would need
      while (Date.now() < until);
      return c.token === "old";
    };
    const tick = await runTick({ config: { timeBudgetMs: 2_000, providerTimeoutMs: 1_000 } });
    expect(tick.publishing.counts).toMatchObject({ released: 1, done: 0 });
    expect(refreshCalls).toBe(0);
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "scheduled", attemptCount: 0 });
  });
});
