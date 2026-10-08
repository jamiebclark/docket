// Banner text for a failed connect, shared by the accounts page and the connect service so the activity
// message is byte-for-byte what the banner shows.

export const CONNECT_BANNER: Record<string, string> = {
  cancelled: "Connecting was cancelled. Nothing changed.",
  platform_error: "The platform returned an error. Nothing changed. Try again.",
  exchange_failed: "Could not finish signing in. Check the app id, secret and redirect address in the setup guide.",
  no_candidates: "No accounts were found for this login. Check the permissions you granted and try again.",
  too_many: "That login found too many accounts to list. Narrow the permissions you granted and try again.",
  not_allowed: "Only project owners and admins can connect accounts.",
};

export const HINTED_CODES: ReadonlySet<string> = new Set(["platform_error", "exchange_failed", "no_candidates"]);

/** The platform's own message (when sealed for this project, group and code) replaces the generic text; the group hint is appended. */
export function connectBannerText({ code, own, hint }: { code: string; own?: string | null; hint?: string | null }): string | undefined {
  const base = own ?? CONNECT_BANNER[code];
  return base && hint ? `${base} ${hint}` : base;
}
