import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { ReplyPanel } from "../../../src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel";
import { dismissItems } from "../../../src/server/services/engagement/review";
import { getInboxItem, listEngagementAccounts } from "../../../src/server/services/engagement/inbox";
import { closeDb } from "../../helpers/db";
import { fakeSession } from "../../helpers/auth";
import { forProject } from "../../../src/server/dal/scope";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

async function seed(providerKey: "facebook" | "instagram") {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const account = await scope.accounts.upsertConnected({
    providerKey,
    displayName: `Test ${providerKey}`,
    externalAccountId: `ext-account-${providerKey}`,
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
    grantedScopes:
      providerKey === "facebook"
        ? ["pages_read_engagement", "pages_read_user_content"]
        : ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
  });
  const { id: itemId } = await scope.engagementItems.insertIfAbsent({
    socialAccountId: account.id,
    providerKey,
    kind: "comment",
    externalId: `ext-comment-${providerKey}`,
    text: "Great post!",
    authorDisplayName: "Ada",
    authorHandle: "ada",
    authorExternalId: "ada-1",
    authorUrl: null,
    authorIdentityStable: true,
    saidAt: new Date("2026-01-01T00:00:00Z"),
    ingestedAt: new Date("2026-01-01T00:00:01Z"),
    parentExternalId: `ext-post-${providerKey}`,
  });
  return { scope, account, itemId };
}

describe.each(["facebook", "instagram"] as const)(
  "%s inbox detail view carries no reply composer, no disabled control (US5 scenarios 1, 2, 4; FR-041, FR-042)",
  (providerKey) => {
    it("shows the corrected, deliberate-limit sentence and leaves dismiss, the parent link and the account filter working", async () => {
      const { scope, account, itemId } = await seed(providerKey);
      const item = await getInboxItem(scope, itemId);

      // The reason is the platform-limit sentence, not an account or item problem.
      expect(item.replyable).toEqual({ ok: false, reason: "This platform cannot be replied to through Docket." });
      // Which post it belongs to is still resolved.
      // `url` is null for an external reference: Docket did not publish it, so it never recorded
      // an address for it (G41).
      expect(item.parent).toEqual({ kind: "external_reference", text: null, externalId: `ext-post-${providerKey}`, url: null });

      const markup = renderToStaticMarkup(
        createElement(ReplyPanel, {
          slug: scope.project.slug,
          itemId,
          drafts: item.drafts,
          canReply: true,
          canDismiss: true,
          replyable: item.replyable.ok,
          dismissed: false,
          countingRule: "graphemes",
          maxLength: 280,
          tz: "UTC",
        }),
      );

      // No reply composer and no disabled control in its place.
      expect(markup).not.toMatch(/Request a draft/);
      expect(markup).not.toMatch(/Write a reply/);
      expect(markup).not.toMatch(/disabled="/);
      // Dismiss is still offered.
      expect(markup).toMatch(/Dismiss/);

      // The sentence itself, unprefixed by a fault-report wording.
      expect(item.replyable.ok).toBe(false);
      if (!item.replyable.ok) {
        expect(item.replyable.reason).not.toMatch(/Can't reply/);
      }

      // Dismissing the item still works.
      const { dismissed } = await dismissItems(scope, [itemId]);
      expect(dismissed).toBe(1);
      const afterDismiss = await getInboxItem(scope, itemId);
      expect(afterDismiss.state).toBe("dismissed");

      // The account filter still lists this account.
      const accounts = await listEngagementAccounts(scope);
      expect(accounts.map((a) => a.id)).toContain(account.id);
    });
  },
);
