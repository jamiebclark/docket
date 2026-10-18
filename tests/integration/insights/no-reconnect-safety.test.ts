import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createFakeGraph } from "../../helpers/fake-graph";
import { mockProvider } from "../../../src/providers/mock";
import type { SocialProvider } from "../../../src/providers/types";
import { getDb } from "../../../src/server/db/client";
import { accountMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { claimDueAccountMetricPolls, type InsightsProviderRule } from "../../../src/server/dal/insights-claims";
import { runTick } from "../../../src/server/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { tickConfig } from "../../helpers/tick";
import { parkAllDueTargets } from "../../helpers/scheduling";

afterAll(closeDb);

const NOW = new Date("2026-05-01T00:00:00Z");
const REQUIRED = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];

// Stands in for a real Instagram account under this entry (contracts/provider-insights-081.md §1),
// without depending on Phase 6's reader, which this phase does not need.
const instagramLikeProvider: SocialProvider = {
  ...mockProvider,
  key: "no-reconnect-safety-instagram",
  displayName: "Instagram (test)",
  insights: {
    ...mockProvider.insights!,
    declaration: {
      ...mockProvider.insights!.declaration,
      requiredScopes: REQUIRED,
      missingScopes: { reason: "Reconnect to grant insights access.", docsPath: "meta-setup" },
    },
  },
} as SocialProvider;
registerTestProvider(instagramLikeProvider);

const rule: InsightsProviderRule = { providerKey: instagramLikeProvider.key, requiredScopes: REQUIRED, ephemeralPostTypes: [] };

// A whole tick claims across every project, so rows left behind by other files on this worker's
// database are claimed by this test's tick: `no-reconnect-safety.test.ts` asserts zero HTTP requests
// and saw 1 then 2 across 3 of 20 repetitions in flake-hunt run 39132854448, the count varying with
// the shuffled file order. Parking first is what the other 112 tick tests already do.
beforeEach(parkAllDueTargets);
describe("a pre-081 install's Instagram account stays untouched (FR-023, SC-003, US1-AS2)", () => {
  it("granted_scopes IS NULL: absent from the claim, no lease, no snapshot, no HTTP request", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: instagramLikeProvider.key,
      displayName: "Pre-081 Instagram",
      externalAccountId: "pre-081-ig",
      settings: {},
      // A pre-081 row never had credentials to decrypt in this test; the point is that nothing
      // ever reaches for them — the claim excludes the account before any credential read.
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      // grantedScopes omitted: the column stays NULL, exactly as a pre-081 row would read.
    });

    const claimed = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers: [rule] });
    expect(claimed.some((c) => c.account.id === account.id)).toBe(false);

    const fake = createFakeGraph();
    fake.reset();
    fake.install();
    try {
      await runTick(tickConfig());
    } finally {
      fake.uninstall();
    }
    expect(fake.requests).toHaveLength(0);

    const [poll] = await getDb()
      .select()
      .from(accountMetricPollStates)
      .where(and(eq(accountMetricPollStates.projectId, ctx.project.id), eq(accountMetricPollStates.socialAccountId, account.id)));
    expect(poll).toBeUndefined();

    const [snapshot] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.socialAccountId, account.id)));
    expect(snapshot).toBeUndefined();
  });
});
