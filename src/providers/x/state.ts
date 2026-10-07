import { z } from "zod";

const imageSchema = z.object({
  mediaId: z.string().min(1).max(64),
  expiresAt: z.number().int().min(0),
  processing: z.enum(["done", "pending"]),
  checks: z.number().int().min(0).max(1000),
  alt: z.boolean(),
  described: z.boolean(),
});

/** Non-secret step state (data-model §5): never a token, code, verifier or URL. */
export const xStateSchema = z.object({
  v: z.literal(1),
  mediaCount: z.number().int().min(0).max(4),
  images: z.array(imageSchema).max(4),
});

export type XState = z.infer<typeof xStateSchema>;
export type XStateImage = XState["images"][number];

/** Null for anything unreadable, including more images than `mediaCount`. Never throws. */
export function parseXState(value: unknown): XState | null {
  const parsed = xStateSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.images.length <= parsed.data.mediaCount ? parsed.data : null;
}
