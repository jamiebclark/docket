import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import PostPage from "../../../src/app/p/[projectSlug]/posts/[postId]/page";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { sessionFor } from "../../helpers/connect-group";

afterAll(closeDb);
let teardown: (() => void) | undefined;
afterEach(() => teardown?.());

async function html(node: unknown): Promise<string> {
  const { prelude } = await prerender(node as never);
  return new Response(prelude).text();
}

async function asOwner<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const session = await sessionFor(userId);
  const { sessionModule } = await import("../../helpers/actions");
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: session.sessionId } })) as never;
  try {
    return await run();
  } finally {
    sessionModule.getSession = original;
  }
}

const NOW = new Date("2026-04-01T00:00:00Z");

/**
 * SC-006, US4-AS1/2/3: one post, one target per platform, each with its own scripted snapshot —
 * proves the panel never sums, averages or relabels across platforms, and never fabricates a row
 * for a metric the response omitted.
 */
describe("the performance panel across Instagram, Facebook, Threads and Bluesky (contracts/provider-insights-081.md §5)", () => {
  it("renders four independent platform blocks with no shared label, aggregate or fabricated row", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);

    const instagram = await repos.accounts.upsertConnected({
      providerKey: "instagram",
      displayName: "IG Account",
      externalAccountId: "ig-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
    });
    const facebook = await repos.accounts.upsertConnected({
      providerKey: "facebook",
      displayName: "FB Page",
      externalAccountId: "fb-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["pages_read_engagement", "read_insights"],
    });
    const threads = await repos.accounts.upsertConnected({
      providerKey: "threads",
      displayName: "Threads Profile",
      externalAccountId: "th-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const bluesky = await repos.accounts.upsertConnected({
      providerKey: "bluesky",
      displayName: "Bluesky Account",
      externalAccountId: "bs-1",
      settings: { pdsUrl: "https://bsky.social" },
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });

    const post = await repos.posts.insert({ baseText: "Hello, everywhere" });
    const targets = await repos.targets.insertMany([
      { postId: post.id, socialAccountId: instagram.id },
      { postId: post.id, socialAccountId: facebook.id },
      { postId: post.id, socialAccountId: threads.id },
      { postId: post.id, socialAccountId: bluesky.id },
    ]);
    const [igTarget, fbTarget, thTarget, bsTarget] = targets;

    for (const [target, externalId] of [
      [igTarget, "ig-media-1"],
      [fbTarget, "fb-post-1"],
      [thTarget, "th-media-1"],
      [bsTarget, "at://bs-1/app.bsky.feed.post/1"],
    ] as const) {
      await repos.targets.update(target!.id, { status: "published", externalId, publishedAt: NOW });
    }

    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: igTarget!.id,
      socialAccountId: instagram.id,
      providerKey: "instagram",
      capturedAt: NOW,
      metrics: { views: 120, likes: 8 },
    });
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: fbTarget!.id,
      socialAccountId: facebook.id,
      providerKey: "facebook",
      capturedAt: NOW,
      metrics: { post_reactions_by_type_total: 6, post_clicks: 2 },
    });
    // Threads declares `unavailable` (research §3), so no snapshot is ever written for it.
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: bsTarget!.id,
      socialAccountId: bluesky.id,
      providerKey: "bluesky",
      capturedAt: NOW,
      metrics: { likeCount: 3 }, // quoteCount omitted on purpose
    });

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    // Instagram's own words, under Instagram's own account name.
    expect(markup).toContain("Views");
    expect(markup).toContain(">120<");
    expect(markup).toContain("Likes");
    expect(markup).toContain(">8<");

    // Facebook's reactions stay broken out under Facebook's own word, not relabelled as Instagram's "Likes".
    expect(markup).toContain("Reactions");
    expect(markup).toContain(">6<");
    expect(markup).toContain("Clicks");
    expect(markup).toContain(">2<");

    // Threads declares a real reader now, but this account never granted `threads_manage_insights`
    // and this install's connect group never asks for it, so the permission reads as not requested:
    // the panel names the permission and fabricates no number. The old placeholder — "Docket has not
    // confirmed which metrics the Threads insights API reports" — is gone for good.
    expect(markup).toContain("threads_manage_insights");
    expect(markup).not.toContain("has not confirmed which metrics");

    // Bluesky: its own Likes row renders, but no Quotes row — the response never reported quoteCount.
    expect(markup).toContain(">3<");

    // No row anywhere for a metric no account reported. Threads declares Replies, Reposts, Quotes
    // and Shares, but holds no snapshot, so none of them earns a row.
    expect(markup).not.toContain(">Replies<");
    expect(markup).not.toContain(">Reposts<");
    expect(markup).not.toContain(">Quotes<");

    // No aggregate figure of any kind: no total/sum of 120+6+3=129, no average, no combined count.
    expect(markup).not.toMatch(/\btotal\b/i);
    expect(markup).not.toMatch(/\baverage\b/i);
    expect(markup).not.toMatch(/\bcombined\b/i);
    expect(markup).not.toContain(">129<");
  });

  /**
   * FR-047, SC-009: the 082 readers alongside Bluesky — same independence, no cross-platform
   * aggregation, and a metric one platform's response omitted produces no row for it.
   */
  it("renders four independent platform blocks for TikTok, Pinterest, X and Bluesky at once", async () => {
    process.env.X_INSIGHTS_ENABLED = "true";
    teardown = () => {
      delete process.env.X_INSIGHTS_ENABLED;
    };
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);

    const tiktok = await repos.accounts.upsertConnected({
      providerKey: "tiktok",
      displayName: "TikTok Account",
      externalAccountId: "tt-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["video.list", "user.info.stats"],
    });
    const pinterest = await repos.accounts.upsertConnected({
      providerKey: "pinterest",
      displayName: "Pinterest Account",
      externalAccountId: "pin-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["pins:read"],
    });
    const x = await repos.accounts.upsertConnected({
      providerKey: "x",
      displayName: "X Account",
      externalAccountId: "x-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["tweet.read"],
    });
    const bluesky = await repos.accounts.upsertConnected({
      providerKey: "bluesky",
      displayName: "Bluesky Account",
      externalAccountId: "bs-2",
      settings: { pdsUrl: "https://bsky.social" },
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });

    const post = await repos.posts.insert({ baseText: "Hello, everywhere (four-platform)" });
    const targets = await repos.targets.insertMany([
      { postId: post.id, socialAccountId: tiktok.id },
      { postId: post.id, socialAccountId: pinterest.id },
      { postId: post.id, socialAccountId: x.id },
      { postId: post.id, socialAccountId: bluesky.id },
    ]);
    const [ttTarget, pinTarget, xTarget, bsTarget] = targets;

    for (const [target, externalId, publicPostId] of [
      [ttTarget, "tt-video-1", "tt-video-1"],
      [pinTarget, "pin-pin-1", null],
      [xTarget, "2002", null],
      [bsTarget, "at://bs-2/app.bsky.feed.post/1", null],
    ] as const) {
      await repos.targets.update(target!.id, { status: "published", externalId, publicPostId, publishedAt: NOW });
    }

    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: ttTarget!.id,
      socialAccountId: tiktok.id,
      providerKey: "tiktok",
      capturedAt: NOW,
      metrics: { tiktok_like_count: 50, comment_count: 4, share_count: 2, view_count: 900 },
    });
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: pinTarget!.id,
      socialAccountId: pinterest.id,
      providerKey: "pinterest",
      capturedAt: NOW,
      metrics: { IMPRESSION: 240, PIN_CLICK: 37, SAVE: 20 }, // OUTBOUND_CLICK omitted on purpose
    });
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: xTarget!.id,
      socialAccountId: x.id,
      providerKey: "x",
      capturedAt: NOW,
      metrics: { like_count: 11, retweet_count: 3 }, // reply_count, quote_count, bookmark_count, impression_count omitted
    });
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: bsTarget!.id,
      socialAccountId: bluesky.id,
      providerKey: "bluesky",
      capturedAt: NOW,
      metrics: { likeCount: 7 },
    });

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    // TikTok's own words and numbers.
    expect(markup).toContain(">50<");
    expect(markup).toContain("Comments");
    expect(markup).toContain(">4<");
    expect(markup).toContain("Shares");
    expect(markup).toContain(">2<");
    expect(markup).toContain("Views");
    expect(markup).toContain(">900<");

    // Pinterest's own words; Outbound clicks never rendered because the snapshot omitted it.
    expect(markup).toContain("Impressions");
    expect(markup).toContain(">240<");
    expect(markup).toContain("Pin clicks");
    expect(markup).toContain(">37<");
    expect(markup).toContain("Saves");
    expect(markup).toContain(">20<");
    expect(markup).not.toContain("Outbound clicks");

    // X's own words; the four omitted keys never render a row.
    expect(markup).toContain(">11<");
    expect(markup).toContain("Reposts");
    expect(markup).toContain(">3<");
    expect(markup).not.toContain("Bookmarks");

    // Bluesky's own Likes row; no Reposts/Quotes row for it (its response never reported them).
    expect(markup).toContain(">7<");

    // No aggregate figure of any kind: no total/sum/average/combined across platforms.
    expect(markup).not.toMatch(/\btotal\b/i);
    expect(markup).not.toMatch(/\baverage\b/i);
    expect(markup).not.toMatch(/\bcombined\b/i);
  });
});
