import { describe, expect, it } from "vitest";
import { activityLink, type ActivityLinkRow } from "./links";

const row = (o: Partial<ActivityLinkRow>): ActivityLinkRow => ({
  kind: "target_failed",
  outcome: "failed",
  postId: "p1",
  postTargetId: "t1",
  postDeleted: false,
  targetStatus: "failed",
  socialAccountId: null,
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
  it("sends an engagement row to the Inbox, filtered to the account that received it", () => {
    const engagement = row({ kind: "engagement_received", outcome: "engagement", postId: null, postTargetId: null, targetStatus: null, socialAccountId: "acct-1" });
    expect(activityLink(engagement, "acme")).toEqual({ href: "/p/acme/inbox?state=waiting&account=acct-1", label: "Open the Inbox" });
  });
  it("still links an engagement row with no account, rather than leading nowhere", () => {
    const engagement = row({ kind: "engagement_ambiguous", outcome: "ambiguous", postId: null, postTargetId: null, targetStatus: null });
    expect(activityLink(engagement, "acme")?.href).toBe("/p/acme/inbox?state=waiting");
  });
  it("sends account rows to accounts", () => {
    expect(activityLink(row({ kind: "account_needs_reauth", outcome: "needs_reauth", postId: null, postTargetId: null, targetStatus: null }), "acme")?.href).toBe("/p/acme/accounts");
  });
});
