import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import InsightsPage from "../../../src/app/p/[projectSlug]/insights/page";
import InsightsLoading from "../../../src/app/p/[projectSlug]/insights/loading";
import InsightsError from "../../../src/app/p/[projectSlug]/insights/error";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  actAs(null);
  await closeDb();
});

beforeEach(() => actAs(null));

const render = async (slug: string) => renderToStaticMarkup(await InsightsPage({ params: Promise.resolve({ projectSlug: slug }) }));

describe("insights page (quickstart.md §6, FR-070 to FR-074)", () => {
  it("shows an EmptyState naming what has to happen when the project has no accounts", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const html = await render(env.project.slug);
    expect(html).toContain("Connect an account");
    expect(html).not.toContain("<polyline"); // no chart mark, only the EmptyState's own decorative icon
  });

  it("renders a chart, its accessible table, and the range/'as of' text for a connected account with readings (FR-016, FR-072)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt: new Date(), metrics: { followersCount: 42 } });
    actAs(env.owner);
    const html = await render(env.project.slug);

    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain("Followers");
    expect(html).toContain("42");
    expect(html).toContain("as of");
    expect(html).toContain('<caption class="sr-only">');
  });

  it("draws the single reading as a point, never an empty box, on a one-reading series (charts.md §5)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt: new Date(), metrics: { followersCount: 42 } });
    actAs(env.owner);
    const html = await render(env.project.slug);

    // A <polyline> of one vertex renders nothing at all, which is the empty chart §5 forbids.
    expect(html, "the one point must be drawn").toContain("<circle");
    expect(html).toContain("A trend needs more than one reading.");
    // And it must not be given a full plot area to sit alone in.
    expect(html).toMatch(/viewBox="0 0 480 56"/);
  });

  it("never lets a chart scale past the size it was laid out for", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt: new Date(), metrics: { followersCount: 42 } });
    actAs(env.owner);
    const html = await render(env.project.slug);
    // width="100%" on its own stretched a 480-wide viewBox to the card, half again its height.
    expect(html).toContain("max-w-[480px]");
  });

  it("states a note naming the platform, never an empty chart or a zero, when a platform declares no account metrics (FR-015, US1.3)", async () => {
    const env = await postsEnv();
    await env.scope.accounts.upsertConnected({
      providerKey: "threads",
      displayName: "Threads account",
      externalAccountId: "threads-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    actAs(env.owner);
    const html = await render(env.project.slug);

    expect(html).toContain("Threads");
    expect(html).toContain("reports no account numbers");
    expect(html).not.toMatch(/>\s*0\s*</); // no bare zero beside the absent metric (SC-007)
  });

  it("does not require a view permission for members who cannot view posts to be refused with notFound", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    await expect(render(env.project.slug)).resolves.toContain("Insights");
  });

  it("makes no platform HTTP call while rendering, with account trends, comparisons and first-engagement all populated (SC-011)", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt: new Date(), metrics: { followersCount: 42 } });
    const post = await env.scope.posts.insert({ baseText: "A post." });
    const [target] = await env.scope.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await env.scope.targets.update(target!.id, { status: "published", externalId: `ext-${post.id}`, publishedAt: new Date() });
    await env.scope.postMetricSnapshots.insertIfAbsent({ postTargetId: target!.id, socialAccountId: account.id, providerKey: "mock", capturedAt: new Date(), metrics: { likeCount: 5 } });
    actAs(env.owner);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const html = await render(env.project.slug);
      expect(html).toContain("Followers");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // A single published post produces one comparison per dimension per platform-and-metric pair, and
  // none of them can rank anything yet. Before this, each was a full-width card repeating "not
  // enough posts" — on a real project that was 75 of them, which is what made the page unreadable.
  it("counts the comparisons that cannot rank instead of giving each one a card", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const post = await env.scope.posts.insert({ baseText: "A post." });
    const [target] = await env.scope.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await env.scope.targets.update(target!.id, { status: "published", externalId: `ext-${post.id}`, publishedAt: new Date() });
    await env.scope.postMetricSnapshots.insertIfAbsent({
      postTargetId: target!.id,
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: new Date(),
      metrics: { likeCount: 5 },
    });
    actAs(env.owner);

    const html = await render(env.project.slug);
    expect(html).toContain("waiting for more posts");
    // Still reachable, inside the disclosure — collapsed, never dropped.
    expect(html).toContain("Not enough posts yet to rank");
    expect(html).toContain("<details");
  });
});

describe("insights loading and error states", () => {
  it("loading.tsx renders a busy skeleton", () => {
    const html = renderToStaticMarkup(createElement(InsightsLoading));
    expect(html).toContain('aria-busy="true"');
  });

  it("error.tsx renders an alert with a retry control and does not blank the page", () => {
    const html = renderToStaticMarkup(createElement(InsightsError, { error: new Error("boom"), reset: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
  });
});

describe("no chart component carries \"use client\"", () => {
  it("TrendChart.tsx is a server component", () => {
    const source = readFileSync("src/components/insights/TrendChart.tsx", "utf8");
    expect(source).not.toMatch(/^"use client";?$/m);
  });
});
