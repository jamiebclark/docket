import { z } from "zod";

export const LINK_URL_MAX = 500;
export const LINK_URL_LENGTH_MESSAGE = "Keep links to 500 characters or fewer";
export const HTTP_LINK_MESSAGE = "Enter a full http or https link";

/** True only for an absolute http(s) URL the WHATWG parser accepts. */
export function isHttpUrl(value: string): boolean {
  try {
    const p = new URL(value).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/** Trimmed, length-capped, then scheme-checked — in that order. */
export const linkUrlSchema: z.ZodType<string> = z
  .string()
  .trim()
  .max(LINK_URL_MAX, { error: LINK_URL_LENGTH_MESSAGE })
  .refine(isHttpUrl, { error: HTTP_LINK_MESSAGE });
