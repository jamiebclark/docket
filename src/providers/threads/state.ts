import { z } from "zod";

const id = z.string().regex(/^\d{1,40}$/);

export const threadsStateSchema = z.object({
  v: z.literal(1),
  mediaType: z.enum(["TEXT", "IMAGE", "CAROUSEL"]),
  items: z.array(id).max(20),
  container: id.nullable(),
  createdAt: z.iso.datetime().nullable(),
  checks: z.number().int().min(0),
  ready: z.boolean(),
  quotaChecked: z.boolean(),
  recreations: z.number().int().min(0).max(2),
});
export type ThreadsState = z.infer<typeof threadsStateSchema>;
