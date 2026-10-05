import { z } from "zod";
import { findProvider } from "../../providers/registry";

export const VOICE_NAME_MAX = 80;
const FIELD_MAX = 2000;
const HASHTAG = /^[\p{L}\p{N}_]{1,100}$/u;

const text = (max = FIELD_MAX) => z.string().trim().max(max, { error: `Keep this to ${max} characters or fewer` });

/** Trimmed, with empty entries dropped, before the count limit applies. */
const dropEmpty = (items: string[]) => items.filter((s) => s.length > 0);

export const voiceNameSchema = z
  .string()
  .trim()
  .min(1, { error: "Name the profile" })
  .max(VOICE_NAME_MAX, { error: `Keep the name to ${VOICE_NAME_MAX} characters or fewer` });

const examplePosts = z
  .array(text(3000))
  .transform(dropEmpty)
  .pipe(z.array(z.string()).max(10, { error: "Add at most 10 example posts" }));

const preferredLinks = z
  .array(
    z.object({
      url: z
        .string()
        .trim()
        .max(500, { error: "Keep links to 500 characters or fewer" })
        .refine((u) => {
          try {
            const p = new URL(u).protocol;
            return p === "http:" || p === "https:";
          } catch {
            return false;
          }
        }, { error: "Enter a full http or https link" }),
      label: text(80).default(""),
    }),
  )
  .max(20, { error: "Add at most 20 links" });

/** `#Tag` and `tag` are the same hashtag; stored without the `#`, de-duplicated ignoring case. */
const preferredHashtags = z
  .array(z.string().trim().transform((s) => s.replace(/^#+/, "")))
  .transform(dropEmpty)
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })
  .pipe(
    z
      .array(z.string().regex(HASHTAG, { error: "Hashtags use letters, numbers and underscores only" }))
      .max(30, { error: "Add at most 30 hashtags" }),
  );

const platformGuidance = z
  .record(z.string(), text())
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!findProvider(key)) ctx.addIssue({ code: "custom", path: [key], message: `Unknown platform: ${key}` });
    }
  })
  .transform((value) => Object.fromEntries(Object.entries(value).filter(([, v]) => v.length > 0)));

export const voiceContentSchema = z.object({
  v: z.literal(1).default(1),
  voiceAndTone: text().default(""),
  audience: text().default(""),
  topicsAndPillars: text().default(""),
  avoid: text().default(""),
  examplePosts: examplePosts.default([]),
  preferredLinks: preferredLinks.default([]),
  preferredHashtags: preferredHashtags.default([]),
  platformGuidance: platformGuidance.default({}),
});

/** What an editor submits: per-platform guidance now lives on accounts, so a stray key is stripped. */
export const voiceContentInputSchema = voiceContentSchema.omit({ platformGuidance: true });

export type VoiceContent = z.infer<typeof voiceContentSchema>;

export const EMPTY_VOICE_CONTENT: VoiceContent = voiceContentSchema.parse({});
