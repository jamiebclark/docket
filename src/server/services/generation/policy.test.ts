import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { PolicyNotAllowedError } from "../../dal/errors";
import type { ApprovalPolicy, ProjectScope, SchedulingPolicy } from "../../dal/scope";
import { roles, type Role } from "../../auth/access";
import { decidePolicy, resolvePolicies } from "./policy";

const APPROVALS: ApprovalPolicy[] = ["review_required", "auto_approve"];
const SCHEDULES: SchedulingPolicy[] = ["leave_as_draft", "add_to_queue"];
const blocking = [{ providerKey: "instagram", message: "Instagram needs an image" }];

describe("decidePolicy", () => {
  it("covers the unblocked rows", () => {
    expect(decidePolicy({ approval: "review_required", scheduling: "leave_as_draft", blocking: [] })).toEqual({
      reviewState: "needs_review", queue: false, reason: "Review required by policy",
    });
    expect(decidePolicy({ approval: "review_required", scheduling: "add_to_queue", blocking: [] })).toEqual({
      reviewState: "needs_review", queue: false, reason: "Review required by policy",
    });
    expect(decidePolicy({ approval: "auto_approve", scheduling: "leave_as_draft", blocking: [] })).toEqual({
      reviewState: "approved", queue: false, reason: "Approved automatically",
    });
    expect(decidePolicy({ approval: "auto_approve", scheduling: "add_to_queue", blocking: [] })).toEqual({
      reviewState: "approved", queue: true, reason: "Approved and queued automatically",
    });
  });

  it.each(APPROVALS.flatMap((a) => SCHEDULES.map((s) => [a, s] as const)))("blocking forces review for %s + %s", (approval, scheduling) => {
    expect(decidePolicy({ approval, scheduling, blocking })).toEqual({
      reviewState: "needs_review", queue: false, reason: "Forced to review: Instagram needs an image",
    });
  });
});

function scopeFor(role: Role, defaults: Partial<ProjectScope["project"]> = {}) {
  const project = { defaultApprovalPolicy: "review_required", defaultSchedulingPolicy: "leave_as_draft", ...defaults };
  const snapshot = JSON.stringify(project);
  const scope = {
    project,
    membership: { role },
    can: (req: Parameters<ProjectScope["can"]>[0]) => roles[role].authorize(req as never).success,
  } as unknown as ProjectScope;
  return { scope, unchanged: () => JSON.stringify(project) === snapshot };
}

describe("resolvePolicies", () => {
  it("uses project defaults for missing or null values", () => {
    const { scope } = scopeFor("editor");
    expect(resolvePolicies(scope, { approval: null })).toEqual({
      requested: { approval: null, scheduling: null },
      resolved: { approval: "review_required", scheduling: "leave_as_draft" },
    });
  });

  it("refuses an editor's auto-approve override, naming the field", () => {
    const { scope, unchanged } = scopeFor("editor");
    try {
      resolvePolicies(scope, { approval: "auto_approve" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyNotAllowedError);
      expect(e).toMatchObject({ message: "Only owners and admins can auto-approve", field: "approval" });
    }
    expect(unchanged()).toBe(true);
  });

  it("lets an editor use an auto-approve project default", () => {
    const { scope } = scopeFor("editor", { defaultApprovalPolicy: "auto_approve" });
    expect(resolvePolicies(scope, {}).resolved.approval).toBe("auto_approve");
    expect(resolvePolicies(scope, { approval: "auto_approve" }).resolved.approval).toBe("auto_approve");
  });

  it.each(["owner", "admin"] as const)("lets %s choose any combination", (role) => {
    const { scope } = scopeFor(role);
    for (const approval of APPROVALS) {
      for (const scheduling of SCHEDULES) {
        const r = resolvePolicies(scope, { approval, scheduling, confirmUnreviewedQueue: true });
        expect(r.resolved).toEqual({ approval, scheduling });
      }
    }
  });

  it("requires confirmation for auto-approve plus queue", () => {
    const { scope } = scopeFor("owner");
    try {
      resolvePolicies(scope, { approval: "auto_approve", scheduling: "add_to_queue" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ZodError);
      expect((e as ZodError).issues[0]).toMatchObject({
        path: ["confirmUnreviewedQueue"],
        message: "Confirm that posts will be approved and queued without review.",
      });
    }
  });
});
