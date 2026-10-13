import { z } from "zod";
import { linkUrlSchema } from "./link";

export const TAGLINE_MAX = 200;
export const BRAND_DESCRIPTION_MAX = 1000;

/** CR/LF runs (with surrounding spaces) collapse to one space; trimmed; empty -> null. */
export function normaliseBrandLine(value: string): string | null {
  const collapsed = value.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
}

/** CRLF -> LF, trimmed, empty -> null; interior blank lines survive. */
export function normaliseBrandText(value: string): string | null {
  const normalised = value.replace(/\r\n/g, "\n").trim();
  return normalised.length > 0 ? normalised : null;
}

export const taglineSchema: z.ZodType<string | null> = z
  .string()
  .transform(normaliseBrandLine)
  .refine((v) => v === null || v.length <= TAGLINE_MAX, {
    error: `Keep this to ${TAGLINE_MAX} characters or fewer`,
  });

export const brandDescriptionSchema: z.ZodType<string | null> = z
  .string()
  .transform(normaliseBrandText)
  .refine((v) => v === null || v.length <= BRAND_DESCRIPTION_MAX, {
    error: `Keep this to ${BRAND_DESCRIPTION_MAX} characters or fewer`,
  });

export const brandWebsiteSchema: z.ZodType<string | null> = z.string().transform((v, ctx) => {
  if (v.trim().length === 0) return null;
  const result = linkUrlSchema.safeParse(v);
  if (!result.success) {
    for (const issue of result.error.issues) ctx.addIssue({ code: "custom", message: issue.message });
    return z.NEVER;
  }
  return result.data;
});
