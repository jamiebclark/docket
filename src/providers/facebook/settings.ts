import { z } from "zod";

export const facebookSettingsSchema = z.object({}).strip();
export type FacebookSettings = z.infer<typeof facebookSettingsSchema>;

/** Ids of unpublished photos, in image order. */
export const facebookStateSchema = z.object({
  v: z.literal(1),
  photoIds: z.array(z.string().min(1).max(100)).max(10),
});
export type FacebookState = z.infer<typeof facebookStateSchema>;
