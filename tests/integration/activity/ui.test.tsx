import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import ActivityPage from "../../../src/app/p/[projectSlug]/activity/page";
import { ActivityFilters } from "../../../src/components/activity/ActivityFilters";
import { ActivityList } from "../../../src/components/activity/ActivityList";
import { CursorPagination } from "../../../src/components/ui/CursorPagination";
import { parseActivityFilter } from "../../../src/server/services/activity/filters";
import type { ActivityRow } from "../../../src/server/services/activity";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  actAs(null);
  await closeDb();
});

const render = async (slug: string, search: Record<string, string> = {}) =>
  renderToStaticMarkup(await ActivityPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve(search) }));

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: randomUUID(),
    kind: "target_failed",
    outcome: "failed",
    occurredAt: new Date("2026-10-01T12:00:00Z"),
    message: "Could not publish.",
    details: {},
    project: { id: randomUUID(), slug: "demo", name: "Demo", timeZone: "UTC" },
    platform: { key: "bluesky", name: "Bluesky" },
    platforms: [],
    account: { id: randomUUID(), name: "@me", removed: false },
    post: { id: randomUUID(), excerpt: "Hello world", deleted: false },
    target: null,
    actor: { kind: "scheduler" },
    actorLabel: "Scheduler",
    link: { href: "/p/demo/failures", label: "Open in Failures" },
    ...over,
  };
}

const list = (rows: ActivityRow[], showProject = false) =>
  renderToStaticMarkup(createElement(ActivityList, { rows, showProject, caption: "Activity" }));

describe("activity list markup", () => {
  it("renders an accessible table with the outcome as text", () => {
    const html = list([row(), row({ outcome: "published", kind: "target_published", message: "Published." })]);
    expect(html).toContain('<caption class="sr-only">');
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(7);
    expect(html).toContain("Failed");
    expect(html).toContain("Published");
    expect(html).toContain("Open in Failures");
    expect(html).toContain("Hello world");
    expect(html).not.toContain("Project</th>");
  });

  it("adds the Project column on the all-projects variant", () => {
    const html = list([row()], true);
    expect(html).toContain("Project</th>");
    expect(html).toContain('href="/p/demo/activity"');
  });

  it("covers moved-on, deleted, removed, former and removed-key rows", () => {
    const moved = list([row({ link: { href: "/p/demo/posts/x", label: "Open post" } })]);
    expect(moved).toContain("Open post");
    const html = list([
      row({ post: { id: "p", excerpt: "Autumn sale", deleted: true }, link: null }),
      row({ account: { id: "a", name: "Removed account", removed: true } }),
      row({ actorLabel: "Former member", actor: { kind: "member", name: null } }),
      row({ actorLabel: "Removed API key", actor: { kind: "api_key", name: null } }),
      row({ kind: "account_connect_failed", outcome: "connect_failed", platform: null, post: null, account: null, link: null, message: "Could not connect." }),
    ]);
    expect(html).toContain("Post deleted");
    expect(html).toContain("Autumn sale");
    expect(html).toContain("Removed account");
    expect(html).toContain("Former member");
    expect(html).toContain("Removed API key");
    expect(html).toContain("Connect failed");
  });

  it("renders details as text", () => {
    const html = list([row({ details: { attempt: 2, nextAttemptAt: "2026-10-01T13:00:00.000Z" } })]);
    expect(html).toContain("Attempt 2");
    expect(html).toContain("next try");
    expect(html).not.toContain("nextAttemptAt");
  });
});

describe("CursorPagination", () => {
  it("links both ways, or disables a missing direction", () => {
    const both = renderToStaticMarkup(createElement(CursorPagination, { newerHref: "/a", olderHref: "/b" }));
    expect(both).toContain('aria-label="Pagination"');
    expect(both).toMatch(/<a[^>]*rel="prev"[^>]*>Newer/);
    expect(both).toMatch(/<a[^>]*rel="next"[^>]*>Older/);
    const one = renderToStaticMarkup(createElement(CursorPagination, { newerHref: null, olderHref: "/b" }));
    expect(one).toContain('<span aria-disabled="true"');
    expect(one).not.toContain('rel="prev"');
  });
});

describe("activity page", () => {
  it("shows the empty state with a Compose link", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const html = await render(env.project.slug);
    expect(html).toContain("Nothing has happened here yet.");
    expect(html).toContain(`/p/${env.project.slug}/compose`);
    expect(html).toContain("<h1");
  });

  it("lists events with a zone note", async () => {
    const env = await postsEnv();
    await env.scope.activity.insert({
      kind: "target_published",
      occurredAt: new Date(),
      postId: randomUUID(),
      postTargetId: randomUUID(),
      socialAccountId: randomUUID(),
      providerKey: "bluesky",
      message: "Published to Bluesky.",
      details: {},
    });
    actAs(env.owner);
    const html = await render(env.project.slug);
    expect(html).toContain("Published to Bluesky.");
    expect(html).toContain(`Times are in ${env.scope.project.timezone}`);
  });

  it("labels every filter control and keeps them natively keyboard-operable", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const html = await render(env.project.slug, { outcome: "failed", from: "2026-01-01", to: "2026-01-31" });
    for (const id of ["activity-from", "activity-to"]) expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(html).toContain("<legend");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="outcome"[^>]*checked=""[^>]*value="failed"/);
    expect(html).toContain("Days in ");
    expect(html).toContain("<noscript>");
    expect(html).toContain('aria-label="Date range"');
    // Filters are native controls and links, so Tab/Space/Enter work without script.
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).not.toMatch(/<(div|span)[^>]*onclick/i);
    expect(html).toContain("Clear filters");
  });

  it("marks the active preset and range with aria-current and drops paging from filter links", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const html = await render(env.project.slug, { outcome: "problems", range: "7d", before: "abc" });
    expect(html).toMatch(/aria-current="page"[^>]*href="[^"]*outcome=problems[^"]*">Problems/);
    expect(html).toMatch(/aria-current="page"[^>]*href="[^"]*range=7d[^"]*">7 days/);
    expect(html).not.toContain("before=");
  });

  it("shows the range message instead of rows when the start is after the end", async () => {
    const env = await postsEnv();
    await env.scope.activity.insert({
      kind: "target_published",
      occurredAt: new Date(),
      postId: randomUUID(),
      postTargetId: randomUUID(),
      socialAccountId: randomUUID(),
      providerKey: "bluesky",
      message: "Should not show.",
      details: {},
    });
    actAs(env.owner);
    const html = await render(env.project.slug, { from: "2026-02-01", to: "2026-01-01" });
    expect(html).toMatch(/role="alert"[^>]*>(<div[^>]*>)?The start date is after the end date\./);
    expect(html).not.toContain("Should not show.");
  });

  it("shows the summary label with counts that link to the presets and keep the other filters", async () => {
    const env = await postsEnv();
    await env.scope.activity.insert({
      kind: "target_published",
      occurredAt: new Date(),
      postId: randomUUID(),
      postTargetId: randomUUID(),
      socialAccountId: randomUUID(),
      providerKey: "bluesky",
      message: "Published to Bluesky.",
      details: {},
    });
    actAs(env.owner);
    const html = await render(env.project.slug, { range: "7d", platform: "bluesky" });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Last 7 days:");
    expect(html).toMatch(/href="[^"]*platform=bluesky[^"]*range=7d[^"]*outcome=successes"[^>]*>1 success</);
    expect(html).toMatch(/href="[^"]*platform=bluesky[^"]*range=7d[^"]*outcome=problems"[^>]*>0 problems</);
    expect(html).not.toContain("counts ignore the outcome filter");
    const withOutcome = await render(env.project.slug, { outcome: "failed" });
    expect(withOutcome).toContain("(counts ignore the outcome filter)");
  });

  it("shows a filtered-empty state with Clear filters, distinct from the first-run empty state", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    const html = await render(env.project.slug, { outcome: "failed" });
    expect(html).toContain("No activity matches these filters.");
    expect(html).not.toContain("Nothing has happened here yet.");
    expect(html).toContain(`href="/p/${env.project.slug}/activity"`);
  });
});

describe("ActivityFilters", () => {
  it("renders from a bare filter without errors", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityFilters, {
        basePath: "/p/demo/activity",
        filter: { outcomes: null, preset: null, platform: null, accountId: null, from: null, to: null, range: null, projectSlugs: null, invalidRange: false },
        platforms: [{ key: "bluesky", name: "Bluesky" }],
        accounts: [],
        timeZone: "UTC",
      }),
    );
    expect(html).not.toContain("Clear filters");
    expect(html).toContain("All platforms");
  });

  it("keeps the active quick range when the form is submitted with another filter", () => {
    const filter = { outcomes: null, preset: null, platform: null, accountId: null, from: null, to: null, range: "7d" as const, projectSlugs: null, invalidRange: false };
    const html = renderToStaticMarkup(
      createElement(ActivityFilters, { basePath: "/p/demo/activity", filter, platforms: [{ key: "bluesky", name: "Bluesky" }], accounts: [], timeZone: "UTC" }),
    );
    // What a browser submits: every successful control of the form, with the platform changed.
    const form = new URLSearchParams();
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]*)"/.exec(m[0])?.[1];
      const value = /value="([^"]*)"/.exec(m[0])?.[1];
      if (name && value !== undefined) form.append(name, value);
    }
    form.set("platform", "bluesky");
    const raw = Object.fromEntries(form.entries());
    expect(parseActivityFilter(raw, { mode: "lenient" }).filter).toMatchObject({ range: "7d", platform: "bluesky" });
    // A date typed into From or To replaces the range.
    expect(parseActivityFilter({ ...raw, from: "2026-10-01" }, { mode: "lenient" }).filter).toMatchObject({ range: null });
  });
});
