import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/components/notifications/ProblemsCallout", () => ({ ProblemsCallout: () => null }));
vi.mock("@/components/shell/SignedInHeader", () => ({ SignedInHeader: () => null }));

import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import PostsPage from "../../../src/app/p/[projectSlug]/posts/page";
import { postTargets } from "../../../src/server/db/schema/posts";
import { actAs } from "../../helpers/actions";
import { closeDb, testDb } from "../../helpers/db";
import { createPostInReview } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const render = async (page: unknown, slug: string): Promise<string> =>
  renderToStaticMarkup(
    (await (page as (p: unknown) => Promise<ReactNode>)({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) })) as React.ReactElement,
  );

const DEFINITION = "Weekly times this account posts at. Add to queue fills the next free slot.";

describe("posting-slot definition (FR-020)", () => {
  it("appears once with two accounts, for an owner and an editor", async () => {
    const e = await postsEnv();
    await e.account();
    await e.account();
    for (const user of [e.owner, e.editor]) {
      actAs(user);
      const out = await render(AccountsPage, e.project.slug);
      expect(out.split(DEFINITION)).toHaveLength(2);
    }
  });

  it("is absent with no accounts", async () => {
    const e = await postsEnv();
    actAs(e.owner);
    expect(await render(AccountsPage, e.project.slug)).not.toContain(DEFINITION);
  });
});

describe("target statuses on the posts list (FR-030)", () => {
  it("reads '{account}: {label}' for every status, with no raw key", async () => {
    const e = await postsEnv();
    actAs(e.owner);
    const cases = [
      ["draft", "Draft"],
      ["scheduled", "Scheduled"],
      ["publishing", "Publishing"],
      ["published", "Published"],
      ["failed", "Failed"],
      ["ambiguous", "Needs your decision"],
      ["cancelled", "Cancelled"],
    ] as const;
    const expected: string[] = [];
    for (const [status, label] of cases) {
      const account = await e.account();
      const { targets } = await createPostInReview(e.project.id, { accountIds: [account.id] });
      const now = new Date();
      await testDb()
        .update(postTargets)
        .set({
          status,
          ...(status === "scheduled" || status === "publishing" ? { nextAttemptAt: now, scheduledAt: now, scheduleKind: "explicit" as const } : {}),
          ...(status === "published" ? { externalId: "ext-1" } : {}),
        })
        .where(and(eq(postTargets.projectId, e.project.id), eq(postTargets.id, targets[0]!.id)));
      expected.push(`${account.displayName}: ${label}`);
    }
    const out = (await render(PostsPage, e.project.slug)).replace(/<!-- -->/g, "");
    for (const text of expected) expect(out).toContain(text);
    expect(out).not.toMatch(/: (ambiguous|publishing|scheduled)\b/);
  });
});
