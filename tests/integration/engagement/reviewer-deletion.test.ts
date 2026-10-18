import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { user } from "../../../src/server/db/schema/auth";
import { closeDb, testDb, withDbCause } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

/**
 * `engagement_drafts.reviewed_by_user_id` is ON DELETE SET NULL, like all 38 other actor columns in
 * this schema. `engagement_drafts_decision_names_person` used to require it NOT NULL once a draft was
 * decided, so the two rules contradicted each other: deleting the reviewer set the column null and the
 * check then rejected the delete with 23514, meaning a user who had ever approved or rejected a draft
 * could not be removed at all.
 *
 * It surfaced as the suite's biggest flake rather than as a bug report. `delete from "user"` in
 * security/secret-scan.test.ts failed 8 to 11 of 20 repetitions across four flake hunts, depending on
 * whether a file that leaves a decided draft behind happened to be shuffled ahead of it on the same
 * worker database — and the cause was discarded twice over, by vitest's JSON reporter dropping
 * `error.cause` and by the lane stderr never seeing failures at all.
 */
describe("deleting a user who decided an engagement draft (23514 regression)", () => {
  it("removes the user and keeps the draft, with the reviewer now unknown", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { id: itemId } = await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: `reviewer-deletion-${Date.now()}`,
      text: "Needs an answer",
      authorDisplayName: "Ada",
      authorHandle: "ada",
      authorExternalId: "ada-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: new Date(),
      ingestedAt: new Date(),
      parentExternalId: null,
    });
    await env.scope.engagementDrafts.insert({
      engagementItemId: itemId,
      socialAccountId: account.id,
      text: "An approved answer",
      origin: "person",
    });
    const draftId = (await env.scope.engagementDrafts.listByItem(itemId))[0]!.id;
    await env.scope.engagementDrafts.update(draftId, {
      reviewState: "rejected",
      reviewedAt: new Date(),
      reviewedByUserId: env.owner.id,
    });

    // The delete itself is the assertion: before the constraint was relaxed this threw
    // 23514 on engagement_drafts_decision_names_person.
    await withDbCause("delete the reviewer", () => testDb().delete(user).where(eq(user.id, env.owner.id)));

    const after = await env.scope.engagementDrafts.get(draftId);
    expect(after, "the draft must outlive its reviewer").not.toBeNull();
    expect(after).toMatchObject({ reviewState: "rejected", reviewedByUserId: null });
    // The audit intent the check exists for is kept: when it was decided is still recorded.
    expect(after!.reviewedAt, "reviewed_at must survive the reviewer").not.toBeNull();
  });
});
