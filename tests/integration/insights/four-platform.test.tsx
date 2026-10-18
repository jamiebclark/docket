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

    // Threads: declared unavailable, so its reason renders and no number is fabricated for it.
    expect(markup).toContain("Docket has not confirmed which metrics the Threads insights API reports.");

    // Bluesky: its own Likes row renders, but no Quotes row — the response never reported quoteCount.
    expect(markup).toContain(">3<");

    // No row anywhere for a metric that was never reported (Threads has no declared keys at all).
    expect(markup).not.toContain("Replies");
    expect(markup).not.toContain("Reposts");
    expect(markup).not.toContain("Quotes");

    // No aggregate figure of any kind: no total/sum of 120+6+3=129, no average, no combined count.
    expect(markup).not.toMatch(/\btotal\b/i);
    expect(markup).not.toMatch(/\baverage\b/i);
    expect(markup).not.toMatch(/\bcombined\b/i);
    expect(markup).not.toContain(">129<");
  });
});
