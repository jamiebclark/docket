import { z } from "zod";

export const facebookSettingsSchema = z.object({}).strip();
export type FacebookSettings = z.infer<typeof facebookSettingsSchema>;

/** Unchanged: ids of unpublished photos, in image order. */
export const photoStateSchema = z
  .object({
    v: z.literal(1),
    photoIds: z.array(z.string().min(1).max(100)).max(10),
  })
  .strict();
export type PhotoState = z.infer<typeof photoStateSchema>;

/** A Reel in progress. Times are ISO strings from the engine clock. */
export const reelStateSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("reel"),
    videoId: z.string().regex(/^\d{1,40}$/),
    uploadUrl: z.string().max(500),
    startedAt: z.string(),
    uploadedAt: z.string().nullable(),
    uploadComplete: z.boolean(),
    uploadChecks: z.number().int().min(0),
    finishedAt: z.string().nullable(),
    publishChecks: z.number().int().min(0),
  })
  .strict();
export type ReelState = z.infer<typeof reelStateSchema>;

export const facebookStateSchema = z.union([photoStateSchema, reelStateSchema]);
export type FacebookState = z.infer<typeof facebookStateSchema>;
