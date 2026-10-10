import { describe, expect, it } from "vitest";
import { ROLE_OPTIONS, roleDescription, roleLabel } from "./roles";

describe("roles", () => {
  it("lists Editor, Admin, Owner in order", () => {
    expect(ROLE_OPTIONS.map((o) => o.value)).toEqual(["editor", "admin", "owner"]);
    expect(ROLE_OPTIONS.map((o) => o.label)).toEqual(["Editor", "Admin", "Owner"]);
  });
  it("carries the exact descriptions", () => {
    expect(roleDescription("editor")).toBe(
      "Writes, schedules and generates posts, and uploads media. Can't connect accounts or change posting slots, brand voice or settings.",
    );
    expect(roleDescription("admin")).toBe(
      "Everything an editor can do, plus accounts, posting slots, brand voice, settings and invitations. Can't invite owners or change members' roles.",
    );
    expect(roleDescription("owner")).toBe(
      "Full control, including inviting owners, changing roles and transferring ownership.",
    );
  });
  it("falls back sensibly for unknown keys", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("viewer")).toBe("Viewer");
    expect(roleDescription("viewer")).toBeUndefined();
  });
});
