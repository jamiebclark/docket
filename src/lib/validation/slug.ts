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

export const slugSchema = z
  .string()
  .min(3, { error: "Slug must be at least 3 characters" })
  .max(48, { error: "Slug must be at most 48 characters" })
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    error: "Use lowercase letters, numbers and single hyphens",
  })
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), {
    error: "This slug is reserved",
  });
