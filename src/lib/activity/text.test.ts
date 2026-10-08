import { describe, expect, it } from "vitest";
import { RESOLVE_ACTIONS } from "./details";
import { activityActorLabel, clipMessage, outcomeLabel, resolvedMessage } from "./text";

describe("clipMessage", () => {
  it("keeps short text and clips long text at 500 code points with an ellipsis", () => {
    expect(clipMessage("short")).toBe("short");
    expect(clipMessage("a".repeat(500))).toHaveLength(500);
    const clipped = clipMessage("a".repeat(501));
    expect(Array.from(clipped)).toHaveLength(500);
    expect(clipped.endsWith("…")).toBe(true);
  });
  it("counts code points, not UTF-16 units", () => {
    const clipped = clipMessage("😀".repeat(600));
    expect(Array.from(clipped)).toHaveLength(500);
    expect(clipped.startsWith("😀")).toBe(true);
  });
});

describe("activityActorLabel", () => {
  it("names each actor", () => {
    expect(activityActorLabel({ kind: "scheduler" })).toBe("Scheduler");
    expect(activityActorLabel({ kind: "member", name: "Sam" })).toBe("Sam");
    expect(activityActorLabel({ kind: "member", name: null })).toBe("Former member");
    expect(activityActorLabel({ kind: "api_key", name: "n8n" })).toBe("API key n8n");
    expect(activityActorLabel({ kind: "api_key", name: null })).toBe("Removed API key");
  });
});

describe("resolvedMessage and outcomeLabel", () => {
  it("has a sentence for every action", () => {
    for (const action of RESOLVE_ACTIONS) expect(resolvedMessage({ action }).length).toBeGreaterThan(0);
    expect(resolvedMessage({ action: "marked_published" })).toBe("Marked published.");
    expect(resolvedMessage({ action: "marked_not_published", requeue: "no_free_slot" })).toContain("No free posting slot");
    expect(resolvedMessage({ action: "bulk_retry", mode: "requeue" })).toContain("requeued");
  });
  it("labels outcomes", () => {
    expect(outcomeLabel("ambiguous")).toBe("Needs your decision");
  });
});
