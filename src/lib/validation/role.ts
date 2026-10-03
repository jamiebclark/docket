import { z } from "zod";

export const ROLES = ["owner", "admin", "editor"] as const;
export type Role = (typeof ROLES)[number];

export const roleSchema = z.enum(ROLES, { error: "Choose a role" });
