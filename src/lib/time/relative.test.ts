import { describe, expect, it } from "vitest";
import { relativeTimeText } from "./relative";

const now = new Date("2030-01-10T12:00:00Z");
const ago = (seconds: number) => relativeTimeText(new Date(now.getTime() - seconds * 1000), now);

describe("relativeTimeText", () => {
  it("keeps the scheduler wording", () => {
    expect(ago(45)).toBe("45 s ago");
    expect(ago(12 * 60)).toBe("12 min ago");
    expect(ago(3600)).toBe("1 hour ago");
    expect(ago(3 * 3600)).toBe("3 hours ago");
    expect(ago(4 * 86400)).toBe("4 days ago");
  });

  it("never goes negative", () => {
    expect(relativeTimeText(new Date(now.getTime() + 5000), now)).toBe("0 s ago");
  });
});
