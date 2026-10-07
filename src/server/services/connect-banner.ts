import { decryptSecret, encryptSecret } from "../crypto/secrets";

/** Longest provider message carried to the accounts banner; longer ones fall back to the generic text. */
export const MAX_BANNER_MESSAGE = 500;
/** How long the redirect's notice can be shown; an old URL from history shows the generic text. */
export const BANNER_NOTICE_TTL_MS = 10 * 60_000;

interface BannerTarget {
  projectSlug: string;
  groupKey: string;
  code: string;
}

const aadFor = (t: BannerTarget) => `connect_banner:v1:${t.projectSlug}:${t.groupKey}:${t.code}`;

/**
 * Seals a provider's own connect message for the accounts banner (G18). The redirect URL carries only this
 * ciphertext, so the text never reaches proxy logs or browser history in the clear, and a crafted link cannot
 * put its own words in the banner: it will not decrypt for this project, group and code.
 */
export function sealBannerMessage(target: BannerTarget, message: string, now: Date): string | null {
  if (!message || message.length > MAX_BANNER_MESSAGE) return null;
  return encryptSecret(JSON.stringify({ m: message, exp: now.getTime() + BANNER_NOTICE_TTL_MS }), { aad: aadFor(target) });
}

/** The message when the notice was sealed for this target and has not expired, otherwise null. */
export function openBannerMessage(target: BannerTarget, notice: string, now: Date): string | null {
  if (notice.length > 2000) return null;
  try {
    const payload = JSON.parse(decryptSecret(notice, { aad: aadFor(target) })) as { m?: unknown; exp?: unknown };
    if (typeof payload.m !== "string" || typeof payload.exp !== "number" || payload.exp < now.getTime()) return null;
    return payload.m.length <= MAX_BANNER_MESSAGE ? payload.m : null;
  } catch {
    return null;
  }
}
