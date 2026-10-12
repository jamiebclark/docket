import { describe, expect, it } from "vitest";
import {
  calloutCountText,
  parseSwitchChange,
  platformsOffNote,
  preferenceHelpText,
  projectOffText,
  projectSwitchConfirmation,
  switchConfirmation,
  switchLabel,
  unreadDisplay,
  unreadLabel,
} from "./text";

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

  it("confirms a single switch", () => {
    expect(switchConfirmation("Woodwork", "Failed", true)).toBe(
      "Failed notifications for Woodwork are on. Problems from now on will reach you.",
    );
    expect(switchConfirmation("Woodwork", "Failed", false)).toBe(
      "Failed notifications for Woodwork are off. Its problems still appear in Activity.",
    );
  });

  it("confirms the project-level switch, keeping the off sentence word-for-word", () => {
    expect(projectSwitchConfirmation("Woodwork", true)).toBe(
      "Notifications for Woodwork are on. Problems from now on will reach you.",
    );
    expect(projectSwitchConfirmation("Woodwork", false)).toBe(
      "Notifications for Woodwork are off. Its problems still appear in Activity.",
    );
  });

  it("parses a switch-change query", () => {
    expect(parseSwitchChange({ axis: "kind", key: "failed", on: "1" })).toEqual({ axis: "kind", key: "failed", on: true });
    expect(parseSwitchChange({ axis: "platform", key: "tiktok", on: "0" })).toEqual({ axis: "platform", key: "tiktok", on: false });
    expect(parseSwitchChange({ axis: "project", on: "1" })).toEqual({ axis: "project", on: true });
  });

  it("rejects an unknown axis or a malformed key", () => {
    expect(parseSwitchChange({ axis: "bogus", key: "failed", on: "1" })).toBeNull();
    expect(parseSwitchChange({ axis: "kind", on: "1" })).toBeNull(); // kind with no key
    expect(parseSwitchChange({ axis: "project", key: "x", on: "1" })).toBeNull(); // project with a key
    expect(parseSwitchChange({ axis: "kind", key: "failed", on: "maybe" })).toBeNull();
  });

  it("gives the help text, the project-off text and the platforms-off note", () => {
    expect(preferenceHelpText()).toMatch(/Turning a switch off only hides its notifications/);
    expect(projectOffText()).toBe("Notifications for this project are off.");
    expect(platformsOffNote(["TikTok", "X"])).toBe("Switched off: TikTok, X.");
  });

  it("labels a switch by axis", () => {
    expect(switchLabel("kind", "failed")).toBe("Failed");
    expect(switchLabel("kind", "needs_reauth")).toBe("Needs reconnecting");
    expect(switchLabel("platform", "tiktok", "TikTok")).toBe("TikTok");
  });
});
