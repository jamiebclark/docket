import { describe, expect, it } from "vitest";
import { ACTIVITY_OUTCOMES } from "@/lib/activity/outcomes";
import { isAttentionFor } from "./attention";

describe("isAttentionFor", () => {
  it("counts problems for every member and never successes or retries", () => {
    const counted = ACTIVITY_OUTCOMES.filter((outcome) => isAttentionFor({ outcome, actorUserId: "v" }, "u"));
    expect(counted).toEqual(["failed", "ambiguous", "needs_reauth"]);
    for (const outcome of ["published", "retrying", "resolved"]) {
      expect(isAttentionFor({ outcome, actorUserId: "u" }, "u")).toBe(false);
    }
  });

  it("counts a connect failure only for its actor", () => {
    expect(isAttentionFor({ outcome: "connect_failed", actorUserId: "u" }, "u")).toBe(true);
    expect(isAttentionFor({ outcome: "connect_failed", actorUserId: "v" }, "u")).toBe(false);
  });

  it("counts a connect failure with no actor for nobody", () => {
    expect(isAttentionFor({ outcome: "connect_failed", actorUserId: null }, "u")).toBe(false);
  });
});
