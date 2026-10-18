import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { engagementReplyClaims } from "../../../src/server/db/schema/engagement";
import { user } from "../../../src/server/db/schema/auth";
import { closeDb, testDb, withDbCause } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

/**
 * The sibling of the 0044 regression (engagement/reviewer-deletion.test.ts), found only because
 * fixing that one left `delete from "user"` still failing in the flake hunt.
 *
 * `engagement_reply_claims.released_by_user_id` is ON DELETE SET NULL, but
 * `engagement_reply_claims_member_decision_named` required it NOT NULL whenever the release reason was
 * `member_decision`. Deleting such a user nulled the column and the check rejected the delete with
 * 23514, so that user could not be removed at all. 0045 requires `released_at` instead: the audit fact
 * is when the claim was released, and the person may become unknown.
 */
describe("deleting a user who released a reply claim by member decision (23514 regression)", () => {
  it("removes the user and keeps the claim, with the releaser now unknown", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const itemExternalId = `claim-releaser-${randomUUID()}`;
    await env.scope.engagementReplyClaims.insert({
      socialAccountId: account.id,
      itemExternalId,
      generation: 1,
      draftId: randomUUID(),
      engagementItemId: null,
      approvedByUserId: env.owner.id,
      claimedAt: new Date(),
    });
    const where = and(
      eq(engagementReplyClaims.projectId, env.project.id),
      eq(engagementReplyClaims.socialAccountId, account.id),
      eq(engagementReplyClaims.itemExternalId, itemExternalId),
      eq(engagementReplyClaims.generation, 1),
    );
    await testDb()
      .update(engagementReplyClaims)
      .set({ releaseReason: "member_decision", releasedByUserId: env.owner.id, releasedAt: new Date() })
      .where(where);

    // The delete is the assertion: before 0045 this threw 23514 on
    // engagement_reply_claims_member_decision_named.
    await withDbCause("delete the releaser", () => testDb().delete(user).where(eq(user.id, env.owner.id)));

    const rows = await testDb().select().from(engagementReplyClaims).where(where);
    expect(rows, "the claim must outlive the person who released it").toHaveLength(1);
    expect(rows[0]).toMatchObject({ releaseReason: "member_decision", releasedByUserId: null });
    // The audit fact the check exists for is kept.
    expect(rows[0]!.releasedAt, "released_at must survive the releaser").not.toBeNull();
  });
});
