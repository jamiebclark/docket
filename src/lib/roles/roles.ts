import type { Role } from "@/server/auth/access";

export interface RoleOption {
  value: Role;
  label: string;
  description: string;
}

/** Editor, Admin, Owner, in that order. Every role-showing screen reads from this. */
export const ROLE_OPTIONS: readonly RoleOption[] = [
  {
    value: "editor",
    label: "Editor",
    description:
      "Writes, schedules and generates posts, and uploads media. Can't connect accounts or change posting slots, brand voice or settings.",
  },
  {
    value: "admin",
    label: "Admin",
    description:
      "Everything an editor can do, plus accounts, posting slots, brand voice, settings and invitations. Can't invite owners or change members' roles.",
  },
  {
    value: "owner",
    label: "Owner",
    description: "Full control, including inviting owners, changing roles and transferring ownership.",
  },
];

/** Display name for a role key; an unknown key comes back with its first letter capitalised. */
export function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role.charAt(0).toUpperCase() + role.slice(1);
}

/** One-line summary for a role key; `undefined` for an unknown key. */
export function roleDescription(role: string): string | undefined {
  return ROLE_OPTIONS.find((o) => o.value === role)?.description;
}
