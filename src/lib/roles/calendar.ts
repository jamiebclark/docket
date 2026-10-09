import { firstWithoutActiveSlot, hasActiveSlot } from "./slots";

type Action = { label: string; href: string };

export type CalendarState =
  | { kind: "no_accounts"; message: string; action: Action | null }
  | { kind: "no_slots"; message: string; action: Action | null }
  | { kind: "no_slots_line"; message: string; action: Action | null }
  | { kind: "empty_period"; message: string; action: Action }
  | { kind: "content" };

/** Which calendar state to show. Pure; the page supplies the facts. */
export function calendarState(input: {
  slug: string;
  accounts: readonly { accountId: string; providerAvailable: boolean; active: number }[];
  hasContent: boolean;
  canManageAccounts: boolean;
  canManageSlots: boolean;
  managersToAsk: string;
  todayHref: string;
}): CalendarState {
  const { slug, accounts, hasContent, canManageAccounts, canManageSlots, managersToAsk, todayHref } = input;
  const base = `/p/${slug}`;

  if (accounts.length === 0) {
    return canManageAccounts
      ? {
          kind: "no_accounts",
          message: "No accounts yet. Connect an account to see posts and open posting slots here.",
          action: { label: "Connect an account", href: `${base}/accounts#add-account` },
        }
      : { kind: "no_accounts", message: `No accounts yet. Ask ${managersToAsk} to connect one.`, action: null };
  }

  if (!accounts.some(hasActiveSlot)) {
    const target = firstWithoutActiveSlot(accounts);
    const kind = hasContent ? "no_slots_line" : "no_slots";
    return canManageSlots && target
      ? {
          kind,
          message: "Add posting slots to see open times here.",
          action: { label: "Add posting slots", href: `${base}/accounts#account-${target.accountId}-slots` },
        }
      : { kind, message: `No posting slots yet. Ask ${managersToAsk} to add some.`, action: null };
  }

  if (!hasContent) {
    return {
      kind: "empty_period",
      message: "No posts or open posting slots in this period.",
      action: { label: "Today", href: todayHref },
    };
  }
  return { kind: "content" };
}
