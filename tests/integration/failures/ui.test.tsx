import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import { TargetResolution } from "../../../src/components/targets/TargetResolution";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  actAs(null);
  await closeDb();
});

const render = async (slug: string, search: Record<string, string> = {}) =>
  renderToStaticMarkup(await FailuresPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve(search) }));

describe("failures page markup (FR-013)", () => {
  it("renders a labelled, accessible table with both groups in order", async () => {
    const env = await postsEnv();
    await outcomeTarget(env, "fatal", "the failed one");
    await outcomeTarget(env, "ambiguous", "the ambiguous one");
    actAs(env.owner);
    const html = await render(env.project.slug);

    expect(html).toContain('<caption class="sr-only">');
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(7 + 2 * 6); // 7 columns plus a 6-column log per row
    const groups = [...html.matchAll(/<th scope="rowgroup"[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    expect(groups).toEqual(["Needs your decision", "Failed"]);
    expect((html.match(/<summary[^>]*>\s*Attempt log \(/g) ?? []).length).toBe(2);
    expect(html).toContain("1 need your decision · 1 failed");
    expect(html).toContain("Mark published");
    expect(html).toContain("Mark not published…");
    expect(html).toContain("Retry");
    // The account filter is labelled: a legend while it is a short button row, a label once it is an autocomplete.
    expect(html).toMatch(/<legend[^>]*>Account<\/legend>|<label[^>]*for="failures-account"/);
    expect(html).not.toMatch(/<button[^>]*>\s*<\/button>/);
    expect(html).not.toMatch(/token|secret|password/i);
  });

  it("shows the empty and filtered-empty states", async () => {
    const env = await postsEnv();
    actAs(env.owner);
    expect(await render(env.project.slug)).toContain("Nothing needs attention. Every post that was due went out or is still scheduled.");
    await outcomeTarget(env, "fatal");
    const filtered = await render(env.project.slug, { status: "ambiguous" });
    expect(filtered).toContain("No posts match this filter.");
    expect(filtered).toContain("Clear filters");
  });
});

describe("TargetResolution", () => {
  const actions = { canMarkPublished: false, canRequeue: false, canMarkNotPublished: false, canRetry: false, retryBlockedReason: null };
  const base = { slug: "p", targetId: "t", accountName: "Acme", status: "ambiguous", actions };

  it("says View only in a row and renders nothing in the detail when the viewer cannot schedule", () => {
    expect(renderToStaticMarkup(createElement(TargetResolution, { ...base, canSchedule: false, variant: "row" }))).toContain("View only");
    expect(renderToStaticMarkup(createElement(TargetResolution, { ...base, canSchedule: false, variant: "detail" }))).toBe("");
  });

  it("keeps a live region mounted and gives a blocked retry its reason and a reconnect link", () => {
    const html = renderToStaticMarkup(
      createElement(TargetResolution, {
        ...base,
        status: "failed",
        canSchedule: true,
        variant: "row",
        actions: { ...actions, retryBlockedReason: "Acme needs to be reconnected before this post can be retried." },
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("needs to be reconnected");
    expect(html).toContain('href="/p/p/accounts"');
    expect(html).not.toContain(">Retry<");
  });
});
