import { describe, expect, it } from "vitest";
import { metaEngagementStateSchema, parseEngagementState, shrinkEngagementState, type MetaEngagementState } from "./engagement-state";

describe("metaEngagementStateSchema", () => {
  it("accepts a maximal state", () => {
    const state = {
      v: 1,
      freshSince: 1_700_000_000_000,
      pending: [
        { postId: "1", after: "a" },
        { postId: "2" },
        { postId: "3", after: "c" },
      ],
      catchUp: { postsAfter: "z" },
      done: true,
      selfUsername: "brand",
      lastStep: "catchUp",
    } as const;
    expect(metaEngagementStateSchema.safeParse(state).success).toBe(true);
  });

  it("rejects an extra field", () => {
    expect(metaEngagementStateSchema.safeParse({ v: 1, extra: "nope" }).success).toBe(false);
  });

  it("parses a state with an unknown v to {}", () => {
    expect(parseEngagementState({ v: 2, freshSince: 1 })).toEqual({});
  });

  it("parses unparseable input to {}", () => {
    expect(parseEngagementState("not an object")).toEqual({});
    expect(parseEngagementState(null)).toEqual({});
    expect(parseEngagementState(undefined)).toEqual({});
  });
});

describe("shrinkEngagementState", () => {
  it("drops pending entries oldest-first, then catchUp.postsAfter, ending under the limit", () => {
    // Built by hand, past what the schema's own caps allow, so the guard is exercised directly
    // rather than relying on the real caps alone to prove it (contracts §2 rule 2).
    const state: MetaEngagementState = {
      v: 1,
      pending: [
        { postId: "1".repeat(100), after: "a".repeat(400) },
        { postId: "2".repeat(100), after: "b".repeat(400) },
        { postId: "3".repeat(100), after: "c".repeat(400) },
      ],
      catchUp: { postsAfter: "z".repeat(400) },
    };
    const shrunk = shrinkEngagementState(state);
    const encoded = new TextEncoder().encode(JSON.stringify(shrunk)).length;
    expect(encoded).toBeLessThanOrEqual(1_500);
    expect(shrunk.pending?.length ?? 0).toBeLessThan(state.pending!.length);
  });

  it("drops catchUp.postsAfter once pending alone cannot shrink the state enough", () => {
    const state: MetaEngagementState = { v: 1, catchUp: { postsAfter: "z".repeat(3_000) } };
    const shrunk = shrinkEngagementState(state);
    const encoded = new TextEncoder().encode(JSON.stringify(shrunk)).length;
    expect(encoded).toBeLessThanOrEqual(1_500);
    expect(shrunk.catchUp?.postsAfter).toBeUndefined();
  });

  it("builds the largest allowed value and stays under the database's 2000-byte check", () => {
    const maximal = metaEngagementStateSchema.parse({
      v: 1,
      freshSince: Number.MAX_SAFE_INTEGER,
      pending: [
        { postId: "1".repeat(100), after: "a".repeat(200) },
        { postId: "2".repeat(100), after: "b".repeat(200) },
        { postId: "3".repeat(100), after: "c".repeat(200) },
      ],
      catchUp: { postsAfter: "z".repeat(200) },
      done: true,
      selfUsername: "x".repeat(100),
      lastStep: "catchUp",
    });
    const shrunk = shrinkEngagementState(maximal);
    const encoded = new TextEncoder().encode(JSON.stringify(shrunk)).length;
    expect(encoded).toBeLessThan(2_000);
  });
});
