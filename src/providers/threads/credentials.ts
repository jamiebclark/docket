import { z } from "zod";

export const threadsCredentialsSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  expiryEstimated: z.boolean(),
});
export type ThreadsCredentials = z.infer<typeof threadsCredentialsSchema>;

/** Only `accessToken` is a secret. Null when the stored value is not a Threads credentials blob. */
export function readThreadsCredentials(value: unknown): ThreadsCredentials | null {
  const parsed = threadsCredentialsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
