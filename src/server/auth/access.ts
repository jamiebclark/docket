import { createAccessControl } from "better-auth/plugins/access";

// Later features extend `statements` (accounts, slots, voice, api_keys, posts, generation).
export const statements = {
  project: ["view", "update"],
  member: ["view", "remove", "remove_owner", "update_role", "transfer_ownership"],
  invitation: ["view", "create", "create_owner", "revoke", "regenerate"],
  audit: ["view"],
  account: ["view", "manage"],
  slot: ["view", "manage"],
  media: ["view", "edit"],
  post: ["view", "edit", "schedule", "delete"],
} as const;

export const ac = createAccessControl(statements);

export const owner = ac.newRole({
  project: ["view", "update"],
  member: ["view", "remove", "remove_owner", "update_role", "transfer_ownership"],
  invitation: ["view", "create", "create_owner", "revoke", "regenerate"],
  audit: ["view"],
  account: ["view", "manage"],
  slot: ["view", "manage"],
  media: ["view", "edit"],
  post: ["view", "edit", "schedule", "delete"],
});

export const admin = ac.newRole({
  project: ["view", "update"],
  member: ["view", "remove"],
  invitation: ["view", "create", "revoke", "regenerate"],
  audit: ["view"],
  account: ["view", "manage"],
  slot: ["view", "manage"],
  media: ["view", "edit"],
  post: ["view", "edit", "schedule", "delete"],
});

export const editor = ac.newRole({
  project: ["view"],
  member: ["view"],
  account: ["view"],
  slot: ["view"],
  media: ["view", "edit"],
  post: ["view", "edit", "schedule", "delete"],
});

export const roles = { owner, admin, editor } as const;
export type Role = keyof typeof roles;

export type PermissionRequest = {
  [R in keyof typeof statements]?: readonly (typeof statements)[R][number][];
};
