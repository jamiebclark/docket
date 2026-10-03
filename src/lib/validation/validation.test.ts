import { describe, expect, it } from "vitest";
import {
  approvalPolicySchema,
  emailSchema,
  invitationTokenSchema,
  passwordSchema,
  personNameSchema,
  projectNameSchema,
  roleSchema,
  schedulingPolicySchema,
  slugSchema,
  timeZoneSchema,
} from "./index";

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

describe("validation", () => {
  it("email trims, lowercases and caps length", () => {
    expect(emailSchema.parse("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(ok(emailSchema, "nope")).toBe(false);
    expect(ok(emailSchema, "a".repeat(250) + "@example.com")).toBe(false);
  });

  it("password is 12–128 characters", () => {
    expect(ok(passwordSchema, "x".repeat(11))).toBe(false);
    expect(ok(passwordSchema, "x".repeat(12))).toBe(true);
    expect(ok(passwordSchema, "x".repeat(128))).toBe(true);
    expect(ok(passwordSchema, "x".repeat(129))).toBe(false);
  });

  it("names are trimmed and bounded", () => {
    expect(personNameSchema.parse("  Ada ")).toBe("Ada");
    expect(ok(personNameSchema, "   ")).toBe(false);
    expect(ok(personNameSchema, "a".repeat(101))).toBe(false);
    expect(ok(projectNameSchema, "a".repeat(80))).toBe(true);
    expect(ok(projectNameSchema, "a".repeat(81))).toBe(false);
    expect(ok(projectNameSchema, "")).toBe(false);
  });

  it("slug follows the shape and reserved list", () => {
    for (const good of ["abc", "my-project", "a1b-2c"]) expect(ok(slugSchema, good)).toBe(true);
    for (const bad of ["ab", "a".repeat(49), "My-Project", "-ab", "ab-", "a--b", "a_b", "a b"]) {
      expect(ok(slugSchema, bad)).toBe(false);
    }
    for (const r of ["new", "settings", "api", "setup", "login", "signup", "invitations", "admin", "static", "_next"]) {
      expect(ok(slugSchema, r)).toBe(false);
    }
  });

  it("time zone accepts IANA names and rejects offsets and junk", () => {
    for (const good of ["Europe/London", "Asia/Kolkata", "UTC", "America/Argentina/Buenos_Aires"]) {
      expect(ok(timeZoneSchema, good)).toBe(true);
    }
    for (const bad of ["+02:00", "-05:00", "Foo/Bar", "free text", "", "GMT+2 please"]) {
      expect(ok(timeZoneSchema, bad)).toBe(false);
    }
  });

  it("role and policies are enums", () => {
    for (const r of ["owner", "admin", "editor"]) expect(ok(roleSchema, r)).toBe(true);
    expect(ok(roleSchema, "viewer")).toBe(false);
    expect(ok(approvalPolicySchema, "auto_approve")).toBe(true);
    expect(ok(approvalPolicySchema, "nope")).toBe(false);
    expect(ok(schedulingPolicySchema, "add_to_queue")).toBe(true);
    expect(ok(schedulingPolicySchema, "nope")).toBe(false);
  });

  it("token is 43 base64url chars", () => {
    expect(ok(invitationTokenSchema, "A".repeat(43))).toBe(true);
    expect(ok(invitationTokenSchema, "A".repeat(42))).toBe(false);
    expect(ok(invitationTokenSchema, "A".repeat(42) + "+")).toBe(false);
  });
});
