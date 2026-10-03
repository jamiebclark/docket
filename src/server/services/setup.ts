import { z } from "zod";
import { emailSchema, passwordSchema, personNameSchema } from "@/lib/validation";
import { bootstrapFirstUser, isSetupAvailable } from "../dal/install";
import { SetupUnavailableError } from "../dal/errors";

export const firstUserSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
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
