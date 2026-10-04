/**
 * Returns `next` only when it is a same-origin relative path; otherwise the
 * fallback. Blocks protocol-relative (`//host`), absolute URLs and backslash tricks.
 */
export function safeRedirect(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || next.length === 0) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
}

/**
 * Returns the URL when it is an http(s) link without embedded credentials; otherwise `null`,
 * so a stored `javascript:` or `data:` value is shown as text, never as a link.
 */
export function safeExternalHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}
