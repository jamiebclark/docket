import { z } from "zod";

/** Same as MAX_CANDIDATES in the connect service; re-declared so this file stays free of server imports. */
export const LANDING_MAX = 500;

export interface ConnectLanding {
  accountId: string;
  target: "slots" | "card";
  connected: number;
  reconnected: number;
}

/** Split saved accounts into new and reconnected by the ids that were active before the save. `null` when `saved` is empty. */
export function classifyConnect(saved: readonly { id: string }[], priorIds: ReadonlySet<string>): ConnectLanding | null {
  const first = saved[0];
  if (!first) return null;
  const fresh = saved.filter((a) => !priorIds.has(a.id));
  const landed = fresh[0] ?? first;
  return {
    accountId: landed.id,
    target: fresh.length > 0 ? "slots" : "card",
    connected: fresh.length,
    reconnected: saved.length - fresh.length,
  };
}

/** `/p/{slug}/accounts?landed=…&connected=…&reconnected=…#account-{id}-slots` ("slots") or `#account-{id}` ("card"). */
export function landingHref(slug: string, landing: ConnectLanding): string {
  const query = new URLSearchParams({
    landed: landing.accountId,
    connected: String(landing.connected),
    reconnected: String(landing.reconnected),
  });
  const hash = landing.target === "slots" ? `account-${landing.accountId}-slots` : `account-${landing.accountId}`;
  return `/p/${encodeURIComponent(slug)}/accounts?${query.toString()}#${hash}`;
}

const count = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(LANDING_MAX));

const landingQuery = z
  .object({ landed: z.uuid(), connected: count, reconnected: count })
  .refine((q) => q.connected + q.reconnected >= 1);

/** Validates the page's search params. Returns `null` for anything missing, repeated, malformed or out of range. */
export function parseLanding(
  query: Record<string, string | string[] | undefined> | undefined,
): { accountId: string; connected: number; reconnected: number } | null {
  if (!query) return null;
  const parsed = landingQuery.safeParse({
    landed: query.landed,
    connected: query.connected,
    reconnected: query.reconnected,
  });
  if (!parsed.success) return null;
  const { landed, connected, reconnected } = parsed.data;
  return { accountId: landed, connected, reconnected };
}

/** The sentence announced for the landed account. */
export function landingMessage(counts: { connected: number; reconnected: number }, accountName: string): string {
  const { connected: n, reconnected: m } = counts;
  if (m === 0) {
    if (n === 1) return `Connected ${accountName}. Add posting slots so Add to queue can schedule it.`;
    return `Connected ${n} accounts. Add posting slots for each.`;
  }
  if (n === 0) return m === 1 ? `Reconnected ${accountName}.` : `Reconnected ${m} accounts.`;
  if (n === 1) {
    return `Connected ${accountName} and reconnected ${m} ${m === 1 ? "account" : "accounts"}. Add posting slots so Add to queue can schedule it.`;
  }
  return `Connected ${n} accounts and reconnected ${m}. Add posting slots for each new account.`;
}
