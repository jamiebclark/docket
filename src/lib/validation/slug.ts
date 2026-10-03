import { z } from "zod";

export const RESERVED_SLUGS = [
  "new",
  "settings",
  "api",
  "setup",
  "login",
  "logout",
  "signup",
  "invitations",
  "p",
  "admin",
  "static",
  "_next",
] as const;

export const SLUG_MIN = 3;
export const SLUG_MAX = 48;

export const slugSchema = z
  .string()
  .min(SLUG_MIN, { error: "Slug must be at least 3 characters" })
  .max(SLUG_MAX, { error: "Slug must be at most 48 characters" })
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    error: "Use lowercase letters, numbers and single hyphens",
  })
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), {
    error: "This slug is reserved",
  });
