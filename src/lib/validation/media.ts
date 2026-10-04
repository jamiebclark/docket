import { z } from "zod";

export const TAG_MAX_LENGTH = 40;
export const TAGS_MAX = 20;

/** Trim → lower-case → 1–40 characters of letters, digits, space, `_`, `-` (starting with a letter or digit). */
export const tagSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, { error: "Enter a tag" })
      .max(TAG_MAX_LENGTH, { error: `Tags are at most ${TAG_MAX_LENGTH} characters` })
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, { error: "Use letters, numbers, spaces, - or _" }),
  );

/** At most 20 tags; duplicates (after normalising) collapse, keeping first-seen order. */
export const tagsSchema = z
  .array(tagSchema)
  .transform((tags) => [...new Set(tags)])
  .pipe(z.array(z.string()).max(TAGS_MAX, { error: `At most ${TAGS_MAX} tags` }));

// Search params come from the URL, so a bad value falls back to "not set" rather than failing the page.
const flag = z.literal("1").optional().catch(undefined);
const page = z.coerce.number().int().min(1).optional().catch(undefined);

export const mediaSearchParamsSchema = z.object({
  tag: tagSchema.optional().catch(undefined),
  unused: flag,
  missingAlt: flag,
  q: z.string().trim().max(100).optional().catch(undefined),
  page,
});
export type MediaSearchParams = z.infer<typeof mediaSearchParamsSchema>;

/** URL flags (`?unused=1`) → the boolean filter `listMedia` takes. The one place they meet (F1). */
export function toMediaListInput(p: MediaSearchParams) {
  return {
    ...(p.tag ? { tag: p.tag } : {}),
    ...(p.unused ? { unused: true } : {}),
    ...(p.missingAlt ? { missingAlt: true } : {}),
    ...(p.q ? { q: p.q } : {}),
    ...(p.page ? { page: p.page } : {}),
  };
}

export const POST_LIST_STATUSES = [
  "draft",
  "needs_review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_failed",
  "failed",
  "needs_decision",
] as const;

export const postSearchParamsSchema = z.object({
  status: z.enum(POST_LIST_STATUSES).optional().catch(undefined),
  page,
});
export type PostSearchParams = z.infer<typeof postSearchParamsSchema>;

export const calendarSearchParamsSchema = z.object({
  view: z.enum(["month", "week"]).optional().catch(undefined),
  date: z.iso.date().optional().catch(undefined),
  account: z.uuid().optional().catch(undefined),
});
export type CalendarSearchParams = z.infer<typeof calendarSearchParamsSchema>;

/** `<input type="datetime-local">` without seconds, in the project's time zone. */
export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, { error: "Enter a valid date and time" });

/** Search params may repeat a key; take the first value. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
