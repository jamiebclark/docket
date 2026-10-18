import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { buildTargetInsightsView } from "../../../src/lib/insights/panel";
import { insightsPermissionFor } from "../../../src/lib/insights/eligibility";
import { instagramInsights } from "../../../src/providers/instagram/insights";
import { metaConnectGroup } from "../../../src/providers/meta/connect-group";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { tickConfig } from "../../helpers/tick";
import { parkAllDueTargets } from "../../helpers/scheduling";

afterAll(closeDb);

const IG = "17841400000000000";
const MEDIA = "18000000000000000";
const TOKEN = "EAAB-page-token-0123456789abcdef";
const NOW = new Date("2026-05-01T00:00:00Z");

const ENV_KEYS = ["META_APP_ID", "META_APP_SECRET", "META_INSIGHTS_SCOPES"] as const;
const ORIGINAL: Record<string, string | undefined> = {};

let fake: FakeGraph;
beforeEach(() => {
  for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];
  process.env.META_APP_ID = "12345";
  process.env.META_APP_SECRET = "a".repeat(32);
  process.env.META_INSIGHTS_SCOPES = "true";
  fake = createFakeGraph().install();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  fake.uninstall();
});

const p = (path: string) => `/v26.0${path}`;

// A whole tick claims across every project, so rows left behind by other files on this worker's
// database are claimed by this test's tick: `no-reconnect-safety.test.ts` asserts zero HTTP requests
// and saw 1 then 2 across 3 of 20 repetitions in flake-hunt run 39132854448, the count varying with
// the shuffled file order. Parking first is what the other 112 tick tests already do.
beforeEach(parkAllDueTargets);
describe("US3: the opt-in flag on, a reconnect granting the scope, and Instagram numbers arriving", () => {
  it("the dialog requests the declared scopes while the flag is on (US3-AS1)", () => {
    const requested = metaConnectGroup.optionalScopes?.requested(process.env);
    expect(requested).toEqual(["read_insights", "instagram_manage_insights"]);
  });

  it("an account granted the required scopes is eligible for a claim (US3-AS4)", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "instagram",
      displayName: "Docket Page · Instagram",
      externalAccountId: IG,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
        "instagram_manage_insights",
      ],
    });
    await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: TOKEN }), null);

    const permission = insightsPermissionFor({
      requiredScopes: instagramInsights.declaration.requiredScopes ?? [],
      grantedScopes: account.grantedScopes,
      requestedScopes: metaConnectGroup.optionalScopes?.requested(process.env) ?? [],
      cannotWiden: metaConnectGroup.optionalScopes?.cannotWiden?.(process.env) ?? null,
      missingScopes: instagramInsights.declaration.missingScopes ?? null,
    });
    expect(permission.kind).toBe("ok");

    const post = await repos.posts.insert({ baseText: "Hello" });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(target!.id, { status: "published", externalId: MEDIA, publishedAt: NOW });

    fake.on("GET", p(`/${MEDIA}/insights`), {
      kind: "ok",
      body: {
        data: [
          { name: "views", values: [{ value: 42 }] },
          { name: "likes", values: [{ value: 7 }] },
          { name: "comments", values: [{ value: 1 }] },
        ],
      },
    });

    await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig()));

    const [snapshot] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target!.id)));
    expect(snapshot?.metrics).toEqual({ views: 42, likes: 7, comments: 1 });

    const [pollState] = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, target!.id)));
    expect(pollState?.lastCapturedAt).not.toBeNull();

    // US3-AS5: Instagram's own labels, one "as of" capture time, no cross-platform aggregate.
    const view = buildTargetInsightsView({
      status: "published",
      externalId: MEDIA,
      declaration: instagramInsights.declaration,
      providerName: "Instagram",
      permission,
      snapshot: { capturedAt: snapshot!.capturedAt, metrics: snapshot!.metrics as Record<string, unknown> },
      pollState: {
        nextPollAt: pollState?.nextPollAt ?? null,
        consecutiveFailures: pollState?.consecutiveFailures ?? 0,
        failingSince: pollState?.failingSince ?? null,
        lastError: pollState?.lastError ?? null,
        frozenReason: pollState?.frozenReason ?? null,
      },
      now: new Date(NOW.getTime() + 3_600_000),
    });
    expect(view).toEqual({
      state: "reported",
      capturedAt: snapshot!.capturedAt,
      rows: [
        { label: "Views", value: 42 },
        { label: "Likes", value: 7 },
        { label: "Comments", value: 1 },
      ],
    });
  });
});
