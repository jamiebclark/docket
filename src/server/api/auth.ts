/** Reads the key from `Authorization: Bearer` or `X-API-Key`. Cookies are never read (FR-009). */
export function readKey(headers: Headers): string | null | "conflict" {
  const auth = headers.get("authorization");
  let bearer: string | null = null;
  if (auth !== null) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (!m) return null;
    bearer = m[1]!;
  }
  const header = headers.get("x-api-key")?.trim() || null;
  if (bearer !== null && header !== null && bearer !== header) return "conflict";
  return bearer ?? header;
}
