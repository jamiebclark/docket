import { describe, expect, it } from "vitest";
import {
  ConflictError,
  EmailMismatchError,
  ForbiddenError,
  InvitationInvalidError,
  LastOwnerError,
  NotFoundError,
  SetupUnavailableError,
} from "@/server/dal/errors";
import { fail, failFromError, ok } from "./action-result";

function named(name: string, message = "x") {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe("failFromError", () => {
  it("maps ValidationIssuesError to validation with the issues attached", () => {
    const issues = { t1: [{ code: "text_too_long", message: "Too long", field: "text" }] };
    const e = Object.assign(named("ValidationIssuesError", "internal"), { issues });
    const r = failFromError(e);
    expect(r).toMatchObject({ ok: false, error: "validation", issues });
    expect(JSON.stringify(r)).not.toContain("internal");
  });

  it("maps NotFoundError to not_found without leaking the message", () => {
    const r = failFromError(named("NotFoundError", "project 42 secret"));
    expect(r).toMatchObject({ ok: false, error: "not_found" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("maps ForbiddenError to forbidden", () => {
    expect(failFromError(named("ForbiddenError"))).toMatchObject({ ok: false, error: "forbidden" });
  });
  it("keeps the last_owner message", () => {
    const r = failFromError(named("LastOwnerError", "Transfer ownership first."));
    expect(r).toMatchObject({ error: "last_owner", message: "Transfer ownership first." });
  });
  it("maps LlmNotConfiguredError to conflict and keeps its message", () => {
    const r = failFromError(named("LlmNotConfiguredError", "Generation is not configured. Set: LLM_PROVIDER."));
    expect(r).toMatchObject({ ok: false, error: "conflict", message: "Generation is not configured. Set: LLM_PROVIDER." });
  });

  it("maps PolicyNotAllowedError to forbidden, keeps its message and field", () => {
    const e = Object.assign(named("PolicyNotAllowedError", "Only owners and admins can auto-approve"), { field: "approval" });
    expect(failFromError(e)).toMatchObject({
      ok: false,
      error: "forbidden",
      message: "Only owners and admins can auto-approve",
      fieldErrors: { approval: "Only owners and admins can auto-approve" },
    });
  });

  it.each([
    ["InvitationInvalidError", "invitation_invalid"],
    ["EmailMismatchError", "email_mismatch"],
    ["SetupUnavailableError", "setup_unavailable"],
  ])("maps %s to %s without leaking the message", (name, code) => {
    const r = failFromError(named(name, "token abc123"));
    expect(r).toMatchObject({ ok: false, error: code });
    expect(JSON.stringify(r)).not.toContain("abc123");
  });
  it("passes ConflictError's message and field through", () => {
    const r = failFromError(new ConflictError("That slug is taken.", "slug"));
    expect(r).toEqual({
      ok: false,
      error: "conflict",
      message: "That slug is taken.",
      fieldErrors: { slug: "That slug is taken." },
    });
  });
  it("passes a field-less ConflictError message through", () => {
    const r = failFromError(new ConflictError("Regenerate the existing invitation instead."));
    expect(r).toEqual({
      ok: false,
      error: "conflict",
      message: "Regenerate the existing invitation instead.",
    });
  });
  it("maps every DAL error class by its name", () => {
    for (const E of [NotFoundError, ForbiddenError, LastOwnerError, InvitationInvalidError, EmailMismatchError, SetupUnavailableError]) {
      expect(() => failFromError(new E())).not.toThrow();
    }
  });
  it("rethrows unknown errors", () => {
    expect(() => failFromError(new Error("boom"))).toThrow("boom");
    expect(() => failFromError("str")).toThrow();
  });
  it("ok/fail helpers still work", () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    expect(fail("validation", "m", { a: "b" })).toMatchObject({ fieldErrors: { a: "b" } });
  });
});
