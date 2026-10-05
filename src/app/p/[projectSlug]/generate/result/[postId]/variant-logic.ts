// Pure helpers for the variant editor: what to send to the check route, and a debounce for it.
import type { CheckResult } from "../../../compose/composer-logic";

export interface VariantCard {
  /** The variant key: the platform, or `<platform>_<n>` when the post has several variants for it. */
  key: string;
  providerKey: string;
  providerName: string;
  accountIds: string[];
  accountNames: string[];
  text: string;
}

export const CHECK_DEBOUNCE_MS = 300;

/** The cards carrying the live text, keyed by the card's own `key` (two cards can share a provider). */
export function liveCards(cards: readonly VariantCard[], texts: Readonly<Record<string, string>>): VariantCard[] {
  return cards.map((c) => ({ ...c, text: texts[c.key] ?? c.text }));
}

/** The `{ accountIds, text }` edits to save for the current cards. */
export function editsFor(cards: readonly VariantCard[]) {
  return cards.map((c) => ({ accountIds: c.accountIds, text: c.text }));
}

export function checkInputFor(postId: string, cards: readonly VariantCard[], mediaIds: readonly string[]) {
  return {
    postId,
    baseText: cards[0]?.text ?? "",
    mediaIds: [...mediaIds],
    targets: cards.flatMap((c) => c.accountIds.map((accountId) => ({ accountId, overrideText: c.text }))),
  };
}

/** The count, limit and issues the check reported for a card (its first account stands for the platform). */
export function cardCheck(result: CheckResult | null, card: VariantCard) {
  return result?.targets.find((t) => card.accountIds.includes(t.accountId)) ?? null;
}

/** Calls `run` once, `delay` ms after the last `schedule`; `cancel` drops a pending call. */
export function createDebounce(delay: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(run: () => void) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
