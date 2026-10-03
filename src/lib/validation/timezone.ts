import { z } from "zod";

const SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isValidTimeZone(value: string): boolean {
  if (!SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** IANA zone names only; offsets like `+02:00` are rejected (research D17/F17). */
export const timeZoneSchema = z
  .string()
  .trim()
  .refine(isValidTimeZone, { error: "Choose a valid time zone" });
