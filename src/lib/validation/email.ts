import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, { error: "Email must be at most 254 characters" })
  .pipe(z.email({ error: "Enter a valid email address" }));
