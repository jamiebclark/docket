import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { ReplyPanel } from "../../../src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel";
import { writeReply } from "../../../src/server/services/engagement/draft";
import { getInboxItem } from "../../../src/server/services/engagement/inbox";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

async function seedItem(scope: Awaited<ReturnType<typeof postsEnv>>["scope"], accountId: string) {
  const { id } = await scope.engagementItems.insertIfAbsent({
    socialAccountId: accountId,
    providerKey: "mock",
    kind: "reply",
    externalId: `ext-${Math.random().toString(36).slice(2)}`,
    text: "Great post!",
    authorDisplayName: "Ada",
    authorHandle: "ada",
    authorExternalId: "ada-1",
    authorUrl: null,
    authorIdentityStable: true,
    saidAt: new Date("2026-01-01T00:00:00Z"),
    ingestedAt: new Date("2026-01-01T00:00:01Z"),
    parentExternalId: null,
  });
  return id;
}

describe("ReplyPanel draft history with two concurrent needs_review drafts (review F13, F26)", () => {
  it("renders both drafts, with a note that approving one discards the other, and never an empty heading", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);

    const first = await writeReply(scope, itemId, "First draft, written by a person");
    if (!first.ok) throw new Error("unreachable");
    const second = await writeReply(scope, itemId, "Second draft, requested later");
    if (!second.ok) throw new Error("unreachable");

    const item = await getInboxItem(scope, itemId);
    expect(item.drafts.filter((d) => d.reviewState === "needs_review")).toHaveLength(2);

    const markup = renderToStaticMarkup(
      createElement(ReplyPanel, {
        slug: env.project.slug,
        itemId,
        drafts: item.drafts,
        canReply: true,
        canDismiss: false,
        replyable: true,
        dismissed: false,
        countingRule: "graphemes",
        maxLength: 280,
        tz: "UTC",
      }),
    );

    // The newest draft is the editable one; the older one still renders in the history section.
    expect(markup).toContain("Second draft, requested later");
    expect(markup).toContain("First draft, written by a person");
    expect(markup).toContain("Draft history");
    expect(markup).toContain("Approving one draft discards the other");
  });

  it("never emits an empty Draft history heading when there is only one draft", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const only = await writeReply(scope, itemId, "Only draft");
    if (!only.ok) throw new Error("unreachable");
    const item = await getInboxItem(scope, itemId);

    const markup = renderToStaticMarkup(
      createElement(ReplyPanel, {
        slug: env.project.slug,
        itemId,
        drafts: item.drafts,
        canReply: true,
        canDismiss: false,
        replyable: true,
        dismissed: false,
        countingRule: "graphemes",
        maxLength: 280,
        tz: "UTC",
      }),
    );

    expect(markup).not.toContain("Draft history");
  });
});
