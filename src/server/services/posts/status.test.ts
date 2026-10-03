import { describe, expect, it } from "vitest";
import { derivePostStatus } from "./status";

describe("derivePostStatus (FR-029)", () => {
  it.each([
    ["draft", [], "draft"],
    ["needs_review", ["draft", "cancelled"], "needs_review"],
    ["approved", ["cancelled"], "approved"],
    ["approved", ["scheduled", "draft"], "scheduled"],
    ["approved", ["scheduled", "publishing"], "publishing"],
    ["approved", ["published", "scheduled"], "scheduled"],
    ["approved", ["published", "published"], "published"],
    ["approved", ["published", "cancelled"], "published"],
    ["approved", ["failed", "failed"], "failed"],
    ["approved", ["failed", "ambiguous"], "failed"],
    ["approved", ["ambiguous"], "failed"],
    ["approved", ["published", "failed"], "partially_failed"],
    ["approved", ["published", "ambiguous"], "partially_failed"],
  ] as const)("%s + %j → %s", (review, statuses, expected) => {
    expect(derivePostStatus(review, statuses)).toBe(expected);
  });
});
