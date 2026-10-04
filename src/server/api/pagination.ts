import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, pageQuerySchema } from "@/lib/validation/api";

export { pageQuerySchema, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX };

/** The cursor is opaque to clients: base64url JSON `{ v: 1, o: <offset> }` (research D12). */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; o?: unknown };
    if (parsed.v === 1 && typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch {
    // fall through
  }
  return null;
}

/** Builds `{ data, nextCursor }` from one extra row fetched past the page. */
export function pageOf<T>(rows: T[], limit: number, offset: number): { data: T[]; nextCursor: string | null } {
  const more = rows.length > limit;
  return { data: more ? rows.slice(0, limit) : rows, nextCursor: more ? encodeCursor(offset + limit) : null };
}
