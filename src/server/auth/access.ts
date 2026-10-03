import { createAccessControl } from "better-auth/plugins/access";

// Later features extend `statements` (accounts, slots, voice, api_keys, posts, generation).
export const statements = {
  project: ["view", "update"],
  member: ["view", "remove", "remove_owner", "update_role", "transfer_ownership"],
  invitation: ["view", "create", "create_owner", "revoke", "regenerate"],
  audit: ["view"],
} as const;

export const ac = createAccessControl(statements);

export const owner = ac.newRole({
  project: ["view", "update"],
  member: ["view", "remove", "remove_owner", "update_role", "transfer_ownership"],
  invitation: ["view", "create", "create_owner", "revoke", "regenerate"],
  audit: ["view"],
});

export const admin = ac.newRole({
  project: ["view", "update"],
  member: ["view", "remove"],
  invitation: ["view", "create", "revoke", "regenerate"],
  audit: ["view"],
});

export const editor = ac.newRole({
  project: ["view"],
  member: ["view"],
});

export const roles = { owner, admin, editor } as const;
export type Role = keyof typeof roles;

export type PermissionRequest = {
  [R in keyof typeof statements]?: readonly (typeof statements)[R][number][];
};
