import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import InboxItemPage from "../../../src/app/p/[projectSlug]/inbox/[itemId]/page";
import { actAs } from "../../helpers/actions";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createPostInReview, createProjectWithMembers } from "../../helpers/factories";
import { forProject } from "../../../src/server/dal/scope";
import { fakeSession } from "../../helpers/auth";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";

afterAll(async () => {
  await closeDb();
});

const AT = new Date("2026-10-19T12:00:00Z");

async function renderItem(itemId: string, projectSlug: string, ownerId: string) {
  actAs({ id: ownerId });
  try {
    return renderToStaticMarkup(await InboxItemPage({ params: Promise.resolve({ projectSlug, itemId }) }));
  } finally {
    actAs(null);
  }
}

describe("the item page states the parent context plainly, one of three distinct arms (US3, FR-021, FR-022, FR-023)", () => {
  it("renders a different, non-empty statement for each of the null, resolved and unresolved parent states", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, { displayName: "Mock", settings: {} });

    const { id: nullParentId } = await scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "mention",
      externalId: "mention-no-parent",
      text: "hello there",
      authorDisplayName: "Ada",
      authorHandle: "ada",
      authorExternalId: "ada-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: AT,
      ingestedAt: AT,
      parentExternalId: null,
    });

    const { targets } = await createPostInReview(ctx.project.id, { accountIds: [account.id], baseText: "Our own post" });
    await forSchedulerProject(ctx.project.id).targets.update(targets[0]!.id, { status: "published", externalId: "post-1", publishedAt: AT });

    const { id: resolvedParentId } = await scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: "reply-resolved",
      text: "nice post",
      authorDisplayName: "Bea",
      authorHandle: "bea",
      authorExternalId: "bea-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: AT,
      ingestedAt: AT,
      parentExternalId: "post-1",
      parentPostTargetId: targets[0]!.id,
    });

    const { id: unresolvedParentId } = await scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: "reply-unresolved",
      text: "to someone else",
      authorDisplayName: "Cai",
      authorHandle: "cai",
      authorExternalId: "cai-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: AT,
      ingestedAt: AT,
      parentExternalId: "post-not-ours",
    });

    const nullHtml = await renderItem(nullParentId, ctx.project.slug, ctx.owner.id);
    const resolvedHtml = await renderItem(resolvedParentId, ctx.project.slug, ctx.owner.id);
    const unresolvedHtml = await renderItem(unresolvedParentId, ctx.project.slug, ctx.owner.id);

    expect(nullHtml).toContain("This is not about one of your posts.");
    expect(resolvedHtml).not.toContain("This is not about one of your posts.");
    expect(unresolvedHtml).not.toContain("This is not about one of your posts.");

    expect(resolvedHtml).toContain("On your post");
    expect(resolvedHtml).toContain("Our own post");
    expect(nullHtml).not.toContain("On your post");
    expect(unresolvedHtml).not.toContain("On your post");

    expect(unresolvedHtml).toContain("On a post that is not one of yours");
    expect(unresolvedHtml).toContain("post-not-ours");
    expect(nullHtml).not.toContain("On a post that is not one of yours");
    expect(resolvedHtml).not.toContain("On a post that is not one of yours");
  });
});
