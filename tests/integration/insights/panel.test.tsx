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
import { mockProvider } from "../../../src/providers/mock";
import type { SocialProvider } from "../../../src/providers/types";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { createMockAccount } from "../../helpers/scheduling";
import { sessionFor } from "../../helpers/connect-group";

// US1-AS3: a provider whose connect group never requests the permission, so a held permission
// is impossible and the account reads as `permission_not_requested` (contracts/granted-scopes.md §4).
const notRequestedProvider: SocialProvider = {
  ...mockProvider,
  key: "panel-permission-not-requested",
  insights: {
    ...mockProvider.insights!,
    declaration: {
      ...mockProvider.insights!.declaration,
      requiredScopes: ["needs_insight_scope"],
      missingScopes: { reason: "Reconnect to grant insights access.", docsPath: "meta-setup" },
    },
  },
} as SocialProvider;
registerTestProvider(notRequestedProvider);

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

async function publishedTarget(projectId: string, accountId: string) {
  const repos = forSchedulerProject(projectId);
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await repos.targets.update(target!.id, { status: "published", externalId: "ext-1", publishedAt: NOW });
  return { post, target: target! };
}

describe("the performance panel on the post detail page (contracts/panel.md)", () => {
  it("no snapshot: says the numbers have not been read yet, with no 0 anywhere (US1-AS1)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { post } = await publishedTarget(ctx.project.id, account.id);

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    expect(markup).toContain("have not been read yet");
    const panelMarkup = markup.slice(markup.indexOf("Performance"));
    expect(panelMarkup).not.toMatch(/>0</);
  });

  it("likeCount present, quoteCount absent: only the present row renders, exactly one as-of line (US1-AS2)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, { insightsPostMetrics: { likeCount: 4 } });
    const { post, target } = await publishedTarget(ctx.project.id, account.id);
    const repos = forSchedulerProject(ctx.project.id);
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: NOW,
      metrics: { likeCount: 4 },
    });

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    expect(markup).toContain("Likes");
    expect(markup).toContain(">4<");
    expect(markup).not.toContain("Quotes");
    expect((markup.match(/As of/g) ?? []).length).toBe(1);
  });

  it("no chart, trend, delta or total appears in any rendered state", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { post, target } = await publishedTarget(ctx.project.id, account.id);
    const repos = forSchedulerProject(ctx.project.id);
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: NOW,
      metrics: { likeCount: 4 },
    });

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    expect(markup).not.toMatch(/delta|trend|percent|chart/i);
  });

  it("a gone target says the post is no longer on the platform, with its last snapshot", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { post, target } = await publishedTarget(ctx.project.id, account.id);
    const repos = forSchedulerProject(ctx.project.id);
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: NOW,
      metrics: { likeCount: 2 },
    });
    await getDb()
      .insert(postMetricPollStates)
      .values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, frozenAt: NOW, frozenReason: "gone", nextPollAt: null });

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    expect(markup).toContain("no longer on");
    expect(markup).toContain(">2<");
  });

  it("a frozen-expired target shows every snapshot captured while it lived, with no failure styling (US5-AS4, FR-042)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { post, target } = await publishedTarget(ctx.project.id, account.id);
    const repos = forSchedulerProject(ctx.project.id);
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: target.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: NOW,
      metrics: { likeCount: 3 },
    });
    await getDb()
      .insert(postMetricPollStates)
      .values({ postTargetId: target.id, projectId: ctx.project.id, socialAccountId: account.id, frozenAt: NOW, frozenReason: "expired", nextPollAt: null });

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    expect(markup).toContain("This story has expired; these numbers are final.");
    expect(markup).toContain(">3<");
    expect(markup).toContain("As of");
    expect(markup).not.toMatch(/failing|Reads have been failing/i);
  });

  it("a Meta-like account with no permission renders permission_not_requested, with the guide link and no number, dash or zero (US1-AS3)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, {}, { providerKey: notRequestedProvider.key });
    const { post } = await publishedTarget(ctx.project.id, account.id);

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    expect(markup).toContain("Reconnect to grant insights access.");
    expect(markup).toContain("Learn more");
    const panelMarkup = markup.slice(markup.indexOf("Performance"));
    expect(panelMarkup).not.toMatch(/>\d</);
    expect(panelMarkup).not.toMatch(/>-</);
    expect(panelMarkup).not.toMatch(/>0</);
  });

  it("heading order is unbroken: h2 before the h3 Performance heading, no client component", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { post } = await publishedTarget(ctx.project.id, account.id);

    const page = await asOwner(ctx.owner.id, () => PostPage({ params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) }));
    const markup = await html(page);

    const h2 = markup.indexOf("<h2");
    const h3Performance = markup.indexOf("Performance");
    expect(h2).toBeGreaterThan(-1);
    expect(h3Performance).toBeGreaterThan(h2);
    expect(markup).not.toContain('"use client"');
  });
});
