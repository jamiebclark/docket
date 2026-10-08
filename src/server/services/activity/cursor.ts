// The opaque page cursor: the last row's position, not an offset, so new events landing on top never repeat rows (research P5).

export type ActivityDirection = "older" | "newer";

export interface ActivityCursor {
  /** ISO instant to the millisecond. */
  t: string;
  /** The row's `seq`, a decimal string (it is a bigint). */
  s: string;
  d: ActivityDirection;
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify({ v: 2, t: cursor.t, s: cursor.s, d: cursor.d })).toString("base64url");
}

/** The cursor, or `null` for anything malformed. The caller decides whether that is an error or the first page. */
export function decodeActivityCursor(value: string | null | undefined): ActivityCursor | null {
  if (!value || value.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { v, t, s, d } = parsed as Record<string, unknown>;
    if (v !== 2 || typeof t !== "string" || typeof s !== "string") return null;
    if (!ISO_MS.test(t) || Number.isNaN(Date.parse(t)) || !/^\d{1,19}$/.test(s)) return null;
    if (d !== "older" && d !== "newer") return null;
    return { t, s, d };
  } catch {
    return null;
  }
}
