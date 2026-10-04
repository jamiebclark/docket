import { z } from "zod";

export const instagramSettingsSchema = z.object({ pageId: z.string().regex(/^\d{1,40}$/).optional() }).strip();
export type InstagramSettings = z.infer<typeof instagramSettingsSchema>;
