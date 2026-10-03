import { z } from "zod";

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const weekdaySchema = z
  .number({ error: "Choose a weekday" })
  .int({ error: "Choose a weekday" })
  .min(1, { error: "Choose a weekday" })
  .max(7, { error: "Choose a weekday" });

/** Wall-clock time in the project's zone, 24-hour `HH:MM`. */
export const localTimeSchema = z
  .string({ error: "Enter a time" })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Use 24-hour time as HH:MM" });

export const PUBLISH_LIMIT_MAX_COUNT = 10_000;
export const PUBLISH_LIMIT_MAX_WINDOW_SECONDS = 30 * 86_400;

export const publishLimitSchema = z.object({
  count: z
    .number({ error: "Enter a number of posts" })
    .int({ error: "Enter a whole number of posts" })
    .min(1, { error: "Allow at least 1 post" })
    .max(PUBLISH_LIMIT_MAX_COUNT, { error: "That is too many posts" }),
  windowSeconds: z
    .number({ error: "Enter a window" })
    .int({ error: "Enter a whole number of seconds" })
    .min(60, { error: "The window must be at least a minute" })
    .max(PUBLISH_LIMIT_MAX_WINDOW_SECONDS, { error: "The window can be at most 30 days" }),
});
export type PublishLimitInput = z.infer<typeof publishLimitSchema>;

/** An instant as an ISO-8601 string with an offset or `Z`. */
export const atSchema = z.iso.datetime({ offset: true, error: "Enter a valid date and time" });

export const POST_TEXT_MAX = 20_000;
export const POST_MEDIA_MAX = 10;

export const baseTextSchema = z.string().max(POST_TEXT_MAX, { error: "The post text is too long" });

export const postTargetInputSchema = z.object({
  accountId: z.uuid({ error: "Choose an account" }),
  overrideText: z.string().max(POST_TEXT_MAX, { error: "The override text is too long" }).nullish(),
});

export const postInputSchema = z.object({
  baseText: baseTextSchema.default(""),
  mediaIds: z.array(z.uuid()).max(POST_MEDIA_MAX, { error: "Too many images" }).default([]),
  targets: z
    .array(postTargetInputSchema)
    .max(50, { error: "Too many accounts" })
    .refine((t) => new Set(t.map((x) => x.accountId)).size === t.length, {
      error: "An account can appear only once",
    })
    .default([]),
});
export type PostInput = z.infer<typeof postInputSchema>;

export const displayNameSchema = z
  .string({ error: "Enter a name" })
  .trim()
  .min(1, { error: "Enter a name" })
  .max(100, { error: "Use at most 100 characters" });

export const connectMockSchema = z.object({
  displayName: displayNameSchema,
  settings: z.unknown().optional(),
  simulateCredentialExpiryHours: z.number().int().min(1).max(24 * 365).optional(),
});

export const saveConnectedAccountSchema = z.object({
  providerKey: z.string().regex(/^[a-z0-9-]+$/),
  externalAccountId: z.string().min(1).max(200),
  displayName: displayNameSchema,
  credentials: z.unknown().optional(),
  credentialsExpireAt: z.date().nullish(),
  settings: z.unknown().optional(),
});

export const addSlotSchema = z.object({
  accountId: z.uuid(),
  weekday: weekdaySchema,
  localTime: localTimeSchema,
});

export const registerAssetSchema = z.object({
  storageKey: z.string().min(1).max(500),
  publicUrl: z
    .url({ error: "Enter a valid URL" })
    .refine((u) => u.startsWith("https://") || (process.env.NODE_ENV !== "production" && u.startsWith("http://")), {
      error: "Use an https:// URL",
    }),
  mimeType: z.string().min(1).max(100),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  byteSize: z.number().int().min(0),
  altText: z.string().max(2000).optional(),
});
