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
