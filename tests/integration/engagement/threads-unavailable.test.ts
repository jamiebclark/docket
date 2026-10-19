import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countAccountsOnUnavailableEngagement } from "../../../src/server/dal/engagement-read-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { forProject } from "../../../src/server/dal/scope";
import { getEnv } from "../../../src/server/env";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runEngagementRead } from "../../../src/server/scheduler/engagement-read";
import * as accountsService from "../../../src/server/services/accounts";
import { listEngagementAccounts } from "../../../src/server/services/engagement/inbox";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllEngagementReads } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

beforeEach(parkAllEngagementReads);
afterAll(closeDb);

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function runSection() {
  const config = schedulerConfig(getEnv(), tickConfig(NO_WAIT).config);
  return atTime(AT, () => runEngagementRead({ config, tickId: randomUUID(), startedAt: AT }));
}

describe("a connected Threads account and a scheduler tick (US1 scenario 5, FR-015, FR-016)", () => {
  it("is never claimed, decrypted or called, is reported unavailable, and stays so even once both engagement permissions are granted", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must never be called for an unavailable engagement surface");
    });
    const decryptSpy = vi.spyOn(accountsService, "decryptCredentials");

    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    // Measured before this account exists: the figure is database-wide by design, and the worker
    // database is shared, so the exact claim — this one account is counted exactly once — is a
    // delta. `toBeGreaterThanOrEqual(1)` could not have caught over-counting; this can.
    const unavailableBefore = await countAccountsOnUnavailableEngagement(["threads"]);
    const account = await repos.accounts.upsertConnected({
      providerKey: "threads",
      displayName: "@docket",
      externalAccountId: "9001",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });

    const counts = await runSection();
    expect(counts.claimed).toBe(0);
    expect(counts.unavailable).toBe(unavailableBefore + 1);
    expect(counts.failed).toBe(0);
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(await repos.engagementAccountStates.get(account.id)).toBeNull();

    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const before = await listEngagementAccounts(scope);
    const beforeView = before.find((v) => v.id === account.id);
    expect(beforeView?.unavailable).toEqual({
      reason:
        "Docket cannot read Threads replies or mentions yet: Threads does not publish a confirmed "
        + "read endpoint for either surface, so there is nothing to call. This is not a setting "
        + "you can change or a step that would fix it.",
      docsPath: "meta-setup#engagement",
    });
    expect(before.some((v) => v.id === account.id && !v.unavailable)).toBe(false);

    // Granting both Threads engagement permissions changes nothing: this is not a scope gate.
    await repos.accounts.upsertConnected({
      providerKey: "threads",
      displayName: "@docket",
      externalAccountId: "9001",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["threads_manage_replies", "threads_manage_mentions"],
    });

    const countsAfterGrant = await runSection();
    expect(countsAfterGrant.claimed).toBe(0);
    // The same row, re-upserted with the scopes granted: still one, never two.
    expect(countsAfterGrant.unavailable).toBe(unavailableBefore + 1);

    const after = await listEngagementAccounts(scope);
    const afterView = after.find((v) => v.id === account.id);
    expect(afterView?.unavailable?.reason).toBe(beforeView?.unavailable?.reason);
    expect(afterView?.readPermission).toBeNull();
  });
});
