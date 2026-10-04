import { z } from "zod";

export const threadsCredentialsSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  expiryEstimated: z.boolean(),
});
export type ThreadsCredentials = z.infer<typeof threadsCredentialsSchema>;
