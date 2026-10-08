import { describe, expect, it } from "vitest";
import { activityLink, type ActivityLinkRow } from "./links";

const row = (o: Partial<ActivityLinkRow>): ActivityLinkRow => ({
  kind: "target_failed",
  outcome: "failed",
  postId: "p1",
  postTargetId: "t1",
  postDeleted: false,
  targetStatus: "failed",
  ...o,
});

describe("activityLink", () => {
  it("goes to Failures while the target is still in the event's state", () => {
    expect(activityLink(row({}), "acme")?.href).toBe("/p/acme/failures?target=t1#target-t1");
    expect(activityLink(row({ kind: "target_ambiguous", outcome: "ambiguous", targetStatus: "ambiguous" }), "acme")?.href).toContain("/failures?");
  });
  it("falls back to the post once the target has moved on", () => {
    expect(activityLink(row({ targetStatus: "published" }), "acme")?.href).toBe("/p/acme/posts/p1");
    expect(activityLink(row({ kind: "target_published", outcome: "published", targetStatus: "published" }), "acme")?.href).toBe("/p/acme/posts/p1");
  });
  it("gives nothing for a deleted post that no longer needs attention", () => {
    expect(activityLink(row({ targetStatus: null, postDeleted: true }), "acme")).toBeNull();
  });
  it("sends account rows to accounts", () => {
    expect(activityLink(row({ kind: "account_needs_reauth", outcome: "needs_reauth", postId: null, postTargetId: null, targetStatus: null }), "acme")?.href).toBe("/p/acme/accounts");
  });
});
