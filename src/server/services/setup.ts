import { z } from "zod";
import { bootstrapFirstUser, isSetupAvailable } from "../dal/install";
import { SetupUnavailableError } from "../dal/errors";

export const firstUserSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(100, "Use 100 characters or fewer"),
  email: z.email("Enter a valid email address"),
  password: z
    .string()
    .min(12, "Use at least 12 characters")
    .max(128, "Use 128 characters or fewer"),
});

export async function isAvailable(): Promise<boolean> {
  return isSetupAvailable();
}

/** Throws ZodError for bad input and SetupUnavailableError once an account exists or a race is lost. */
export async function createFirstUser(input: unknown): Promise<{ userId: string; email: string }> {
  const parsed = firstUserSchema.parse(input);
  if (!(await isSetupAvailable())) throw new SetupUnavailableError();
  const { userId } = await bootstrapFirstUser(parsed);
  return { userId, email: parsed.email.toLowerCase() };
}
