import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);
// An async server component cannot render under renderToStaticMarkup; the callout has its own tests.
vi.mock("@/components/notifications/ProblemsCallout", () => ({ ProblemsCallout: () => null }));

import { queryObservers, type ObservedQuery } from "../../../src/server/db/client";
import { closeDb } from "../../helpers/db";
import { actAs } from "../../helpers/actions";
import { postsEnv } from "../../helpers/posts-env";

import PostsPage from "../../../src/app/p/[projectSlug]/posts/page";
import ProjectOverview from "../../../src/app/p/[projectSlug]/(overview)/page";

afterAll(async () => {
  actAs(null);
  await closeDb();
});

beforeEach(() => actAs(null));

const NOW = new Date("2026-10-18T12:00:00Z");

async function renderPosts(slug: string) {
  return renderToStaticMarkup(
    await PostsPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) }),
  );
}

async function renderOverview(slug: string) {
  return renderToStaticMarkup(await ProjectOverview({ params: Promise.resolve({ projectSlug: slug }) }));
}

async function publishedTarget(env: Awaited<ReturnType<typeof postsEnv>>, accountId: string, externalId: string | null) {
  const post = await env.scope.posts.insert({ baseText: `Post ${externalId ?? "by hand"}` });
  const [target] = await env.scope.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await env.scope.targets.update(target!.id, {
    status: "published",
    externalId,
    publishedAt: NOW,
    ...(externalId === null ? { resolvedByUserId: env.owner.id, resolvedAt: NOW } : {}),
  });
  await env.scope.posts.setStatus(post.id, "published");
  return { post, target: target! };
}

describe("per-post numbers where the work happens (quickstart.md §3, US2, FR-021 to FR-024)", () => {
  it("a reported snapshot reads identically — same label, value and 'as of' — on the posts list and the overview (FR-021, FR-022)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { target } = await publishedTarget(env, account.id, "ext-1");
    await env.scope.postMetricSnapshots.insertIfAbsent({ postTargetId: target.id, socialAccountId: account.id, providerKey: "mock", capturedAt: NOW, metrics: { likeCount: 7 } });
    actAs(env.owner);

    const listHtml = await renderPosts(env.project.slug);
    const overviewHtml = await renderOverview(env.project.slug);

    for (const html of [listHtml, overviewHtml]) {
      expect(html).toContain("Likes");
      expect(html).toContain("7");
      expect(html).toContain("As of");
    }
  });

  it("a target with no external id states Docket has no post to read numbers from, on both surfaces (US2.4)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    await publishedTarget(env, account.id, null);
    actAs(env.owner);

    const listHtml = await renderPosts(env.project.slug);
    const overviewHtml = await renderOverview(env.project.slug);

    expect(listHtml).toContain("No post on Mock (offline) to read numbers from.");
    expect(overviewHtml).toContain("No post on Mock (offline) to read numbers from.");
  });

  it("never renders a 0 for a target that has not been polled yet", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    await publishedTarget(env, account.id, "ext-2");
    actAs(env.owner);

    const html = await renderPosts(env.project.slug);
    expect(html).toContain("Not polled yet.");
    const tableBody = html.slice(html.indexOf("<tbody"));
    expect(tableBody).not.toMatch(/>0</);
  });

  it("a project with no insights data at all leaves the overview unchanged apart from an honest empty state, with no extra per-row query (US2.5)", async () => {
    const env = await postsEnv();
    actAs(env.owner);

    const seen: ObservedQuery[] = [];
    const observer = (q: ObservedQuery) => seen.push(q);
    queryObservers.add(observer);
    let html: string;
    try {
      html = await renderOverview(env.project.slug);
    } finally {
      queryObservers.delete(observer);
    }
    expect(html).toContain("No published posts yet.");
    const snapshotQueries = seen.filter((q) => /post_metric_snapshots/.test(q.sql));
    const pollStateQueries = seen.filter((q) => /post_metric_poll_states/.test(q.sql));
    expect(snapshotQueries.length).toBeLessThanOrEqual(1);
    expect(pollStateQueries.length).toBeLessThanOrEqual(1);
  });

  it("the query count for a 25-row page of 3-target posts does not grow with the rows (US2.6, SC-002)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const account2 = await env.account({});
    const account3 = await env.account({});
    for (let i = 0; i < 25; i++) {
      const post = await env.scope.posts.insert({ baseText: `Row ${i}` });
      const targets = await env.scope.targets.insertMany([
        { postId: post.id, socialAccountId: account.id },
        { postId: post.id, socialAccountId: account2.id },
        { postId: post.id, socialAccountId: account3.id },
      ]);
      for (const t of targets) await env.scope.targets.update(t.id, { status: "published", externalId: `ext-${post.id}-${t.id}`, publishedAt: NOW });
      await env.scope.posts.setStatus(post.id, "published");
    }
    actAs(env.owner);

    const seen: ObservedQuery[] = [];
    const observer = (q: ObservedQuery) => seen.push(q);
    queryObservers.add(observer);
    try {
      await renderPosts(env.project.slug);
    } finally {
      queryObservers.delete(observer);
    }
    const snapshotQueries = seen.filter((q) => /post_metric_snapshots/.test(q.sql));
    const pollStateQueries = seen.filter((q) => /post_metric_poll_states/.test(q.sql));
    expect(snapshotQueries).toHaveLength(1);
    expect(pollStateQueries).toHaveLength(1);
  });
});
