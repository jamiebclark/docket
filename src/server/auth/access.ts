import { createAccessControl } from "better-auth/plugins/access";

export const statements = {
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
  api_key: ["manage"],
  webhook: ["manage"],
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
  voice: ["view", "manage"],
  generation: ["run", "auto_approve"],
  api_key: ["manage"],
  webhook: ["manage"],
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
  voice: ["view", "manage"],
  generation: ["run", "auto_approve"],
  api_key: ["manage"],
  webhook: ["manage"],
});

export const editor = ac.newRole({
  project: ["view"],
  member: ["view"],
  account: ["view"],
  slot: ["view"],
  media: ["view", "edit"],
  post: ["view", "edit", "schedule", "delete"],
  voice: ["view"],
  generation: ["run"],
});

export const roles = { owner, admin, editor } as const;
export type Role = keyof typeof roles;

export type PermissionRequest = {
  [R in keyof typeof statements]?: readonly (typeof statements)[R][number][];
};
