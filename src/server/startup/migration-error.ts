/**
 * One line describing why a migration failed, for the two places that report it
 * (`scripts/prestart.mjs` and `startup/index.ts`).
 *
 * Both used to print only `error.code`, which is empty for every failure that is not a Postgres
 * error — a missing `meta/_journal.json`, an unreadable migrations folder, a bad connection string.
 * An operator then saw "database migration failed. Not starting." and nothing else, with no way to
 * tell a drifted schema from migrations missing out of the image.
 *
 * Credentials are scrubbed: a connection error can carry the URL it dialled, and this string goes
 * to container logs (constitution VII).
 */
export function describeMigrationFailure(error: unknown): string {
  if (error === null || error === undefined) return "no error given";
  if (typeof error !== "object") return scrub(String(error));

  const e = error as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
  const code = typeof e.code === "string" || typeof e.code === "number" ? String(e.code) : "";
  const message = typeof e.message === "string" ? e.message.trim() : "";
  const detail = typeof e.detail === "string" ? e.detail.trim() : "";
  const hint = typeof e.hint === "string" ? e.hint.trim() : "";

  const parts = [message, detail, hint].filter(Boolean);
  const described = parts.length > 0 ? parts.join(" — ") : "no message";
  return scrub(code ? `${described} (${code})` : described);
}

/** `postgres://user:secret@host/db` → `postgres://user:***@host/db`, anywhere in the text. */
function scrub(text: string): string {
  return text.replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, "//$1:***@");
}
