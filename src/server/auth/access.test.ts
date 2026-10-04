import { describe, expect, it } from "vitest";
import { roles, statements, type Role } from "./access";

type Resource = keyof typeof statements;

// FR-021 matrix: which actions each role may perform.
const allowed: Record<Role, { [R in Resource]?: readonly string[] }> = {
  owner: {
    project: ["view", "update"],
    member: ["view", "remove", "remove_owner", "update_role", "transfer_ownership"],
    invitation: ["view", "create", "create_owner", "revoke", "regenerate"],
    audit: ["view"],
    account: ["view", "manage"],
    slot: ["view", "manage"],
    media: ["view", "edit"],
    post: ["view", "edit", "schedule", "delete"],
    voice: ["view", "manage"],
    generation: ["run", "auto_approve"],
  },
  admin: {
    project: ["view", "update"],
    member: ["view", "remove"],
    invitation: ["view", "create", "revoke", "regenerate"],
    audit: ["view"],
    account: ["view", "manage"],
    slot: ["view", "manage"],
    media: ["view", "edit"],
    post: ["view", "edit", "schedule", "delete"],
    voice: ["view", "manage"],
    generation: ["run", "auto_approve"],
  },
  editor: {
    project: ["view"],
    member: ["view"],
    account: ["view"],
    slot: ["view"],
    media: ["view", "edit"],
    post: ["view", "edit", "schedule", "delete"],
    voice: ["view"],
    generation: ["run"],
  },
};

describe("access control matrix", () => {
  for (const role of Object.keys(roles) as Role[]) {
    for (const resource of Object.keys(statements) as Resource[]) {
      for (const action of statements[resource]) {
        const expected = allowed[role][resource]?.includes(action) ?? false;
        it(`${role} ${expected ? "can" : "cannot"} ${resource}:${action}`, () => {
          const result = roles[role].authorize({ [resource]: [action] } as never);
          expect(result.success).toBe(expected);
        });
      }
    }
  }

  it("requires every requested action", () => {
    expect(roles.admin.authorize({ member: ["view", "remove_owner"] } as never).success).toBe(false);
  });
});
