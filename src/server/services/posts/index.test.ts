import { describe, expect, it } from "vitest";
import type { PostRecord } from "../../dal/posts";
import { queueFloor } from "./index";

function post(queueNotBefore: Date | null): PostRecord {
  return { queueNotBefore } as unknown as PostRecord;
}

describe("queueFloor (B13)", () => {
  const now = new Date("2027-03-01T00:00:00.000Z");

  it("returns now when the floor is NULL", () => {
    expect(queueFloor(post(null), now)).toEqual(now);
  });

  it("returns now when the floor is in the past", () => {
    const past = new Date("2026-01-01T00:00:00.000Z");
    expect(queueFloor(post(past), now)).toEqual(now);
  });

  it("returns now when the floor equals now", () => {
    expect(queueFloor(post(new Date(now)), now)).toEqual(now);
  });

  it("returns the floor when it is in the future", () => {
    const future = new Date("2027-04-01T00:00:00.000Z");
    expect(queueFloor(post(future), now)).toEqual(future);
  });
});
