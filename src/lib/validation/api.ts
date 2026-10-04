import { z } from "zod";
import { JOB_ITEM_DATA_MAX, JOB_ITEMS_MAX } from "./jobs";

export const API_KEY_PERMISSIONS = ["read", "write_posts", "generate", "auto_approve", "manage_jobs"] as const;
export const apiKeyPermissionSchema = z.enum(API_KEY_PERMISSIONS);

export const API_KEY_EXPIRY_CHOICES = ["never", "30", "90", "365"] as const;
export const API_KEY_CAP = 25;
export const WEBHOOK_ENDPOINT_CAP = 10;

export const createApiKeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Give the key a name" })
    .max(64, { error: "The name is at most 64 characters" }),
  permissions: z
    .array(apiKeyPermissionSchema)
    .min(1, { error: "Choose at least one permission" })
    .refine((p) => new Set(p).size === p.length, { error: "Each permission can be chosen once" }),
  rateLimitPerMinute: z.coerce
    .number()
    .int({ error: "Use a whole number" })
    .min(1, { error: "The limit is at least 1 request a minute" })
    .max(1000, { error: "The limit is at most 1,000 requests a minute" })
    .default(60),
  expiry: z.enum(API_KEY_EXPIRY_CHOICES).default("never"),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/** The `Idempotency-Key` header: 1–255 printable ASCII characters, no spaces. */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7E]{1,255}$/);

export const WEBHOOK_SELECTABLE_EVENTS = ["post.published", "post.failed", "job.finished", "account.needs_reauth"] as const;
export const webhookEventTypeSchema = z.enum(WEBHOOK_SELECTABLE_EVENTS);

export const webhookUrlSchema = z
  .string()
  .trim()
  .max(2000, { error: "The URL is at most 2,000 characters" })
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && u.hostname !== "";
      } catch {
        return false;
      }
    },
    { error: "Enter an http or https URL without a username or password" },
  );

export const webhookEndpointSchema = z.object({
  url: webhookUrlSchema,
  description: z.string().trim().max(200, { error: "The description is at most 200 characters" }).default(""),
  events: z
    .array(webhookEventTypeSchema)
    .min(1, { error: "Choose at least one event" })
    .refine((e) => new Set(e).size === e.length, { error: "Each event can be chosen once" }),
});
export type WebhookEndpointInput = z.infer<typeof webhookEndpointSchema>;

export const upcomingQuerySchema = z.object({
  accountId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(60).default(14),
  from: z.iso.datetime({ offset: true }).optional(),
});
export type UpcomingQuery = z.infer<typeof upcomingQuerySchema>;

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,512}$/)
    .optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const API_ITEMS_PER_CALL_MAX = 100;
export const API_FIELDS_MAX = 50;
export const API_LABEL_MAX = 200;

/** A template field name: what `{{ … }}` may hold (1–64 characters, no braces or line breaks). */
export const fieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^{}\n]+$/, { error: "Field names cannot contain braces or line breaks" });

export const apiSourceSchema = z.object({
  kind: z.literal("api"),
  fields: z
    .array(fieldNameSchema)
    .max(API_FIELDS_MAX)
    .refine((f) => new Set(f).size === f.length, { error: "Field names must be unique" }),
});

export const apiItemSchema = z.object({
  label: z.string().trim().max(API_LABEL_MAX).optional(),
  mediaId: z.uuid().optional(),
  fields: z
    .record(z.string(), z.string())
    .refine((v) => Object.values(v).every((s) => s.length <= JOB_ITEM_DATA_MAX), {
      error: `Each value is at most ${JOB_ITEM_DATA_MAX.toLocaleString("en-US")} characters`,
    }),
});

export const apiSourceInputSchema = apiSourceSchema.extend({
  items: z.array(apiItemSchema).max(API_ITEMS_PER_CALL_MAX).optional(),
  open: z.boolean().optional(),
});
export type ApiSourceInput = z.infer<typeof apiSourceInputSchema>;

export const appendItemsSchema = z.object({
  items: z.array(apiItemSchema).min(1).max(API_ITEMS_PER_CALL_MAX),
});
export type AppendItemsInput = z.infer<typeof appendItemsSchema>;
export { JOB_ITEMS_MAX };
