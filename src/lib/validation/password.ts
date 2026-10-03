import { z } from "zod";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, { error: `Password must be at least ${PASSWORD_MIN} characters` })
  .max(PASSWORD_MAX, { error: `Password must be at most ${PASSWORD_MAX} characters` });
