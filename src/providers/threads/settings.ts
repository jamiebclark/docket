import { z } from "zod";

export const threadsSettingsSchema = z.object({ estimatedExpiry: z.iso.datetime().optional() }).strip();
export type ThreadsSettings = z.infer<typeof threadsSettingsSchema>;
