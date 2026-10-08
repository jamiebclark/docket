import { describe, expect, it } from "vitest";
import { calloutCountText, mutedConfirmation, unreadDisplay, unreadLabel } from "./text";

describe("notification text", () => {
  it("displays the badge", () => {
    expect([0, 1, 99, 100, 150].map(unreadDisplay)).toEqual(["", "1", "99", "99+", "99+"]);
  });

  it("labels the bell", () => {
    expect(unreadLabel(0)).toBe("No unread problems");
    expect(unreadLabel(1)).toBe("1 unread problem");
    expect(unreadLabel(3)).toBe("3 unread problems");
    expect(unreadLabel(100)).toBe("More than 99 unread problems");
  });

  it("words the callout count", () => {
    expect(calloutCountText(1)).toBe("1 problem");
    expect(calloutCountText(2)).toBe("2 problems");
    expect(calloutCountText(100)).toBe("More than 99 problems");
  });

  it("confirms muting and unmuting", () => {
    expect(mutedConfirmation("Acme", false)).toBe("Notifications for Acme are off. Its problems still appear in Activity.");
    expect(mutedConfirmation("Acme", true)).toBe("Notifications for Acme are on. Earlier problems are marked as read.");
  });
});
