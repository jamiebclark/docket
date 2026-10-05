/** Variant grouping by platform and posting instructions. Pure and client-safe: imports nothing from `src/server`. */

/** Interim cap on variants per generation (research R1); the only copy of the number. */
export const GROUP_LIMIT = 16;
export const POSTING_INSTRUCTIONS_MAX = 2000;

export interface GroupAccount {
  id: string;
  providerKey: string;
  displayName: string;
  postingInstructions: string | null;
}

export interface VariantGroup<A extends GroupAccount = GroupAccount> {
  /** Platform key, or `${providerKey}_${n}` (n from 1) when the platform has two or more groups. */
  key: string;
  providerKey: string;
  /** Normalised. */
  instructions: string | null;
  /** Request order. */
  accounts: A[];
}

/** CRLF and lone CR become LF, then the text is trimmed; an empty result is `null`. */
export function normaliseInstructions(text: string | null | undefined): string | null {
  if (text == null) return null;
  const out = text.replace(/\r\n?/g, "\n").trim();
  return out === "" ? null : out;
}

/** Groups by platform and exact (case-sensitive) normalised instructions, in order of first appearance. */
export function groupTargets<A extends GroupAccount>(accounts: readonly A[]): VariantGroup<A>[] {
  const groups: VariantGroup<A>[] = [];
  const index = new Map<string, VariantGroup<A>>();
  for (const account of accounts) {
    const instructions = normaliseInstructions(account.postingInstructions);
    const id = JSON.stringify([account.providerKey, instructions]);
    const existing = index.get(id);
    if (existing) {
      existing.accounts.push(account);
      continue;
    }
    const group: VariantGroup<A> = {
      key: account.providerKey,
      providerKey: account.providerKey,
      instructions,
      accounts: [account],
    };
    index.set(id, group);
    groups.push(group);
  }
  const perPlatform = new Map<string, VariantGroup<A>[]>();
  for (const g of groups) perPlatform.set(g.providerKey, [...(perPlatform.get(g.providerKey) ?? []), g]);
  for (const list of perPlatform.values()) {
    if (list.length < 2) continue;
    list.forEach((g, i) => {
      g.key = `${g.providerKey}_${i + 1}`;
    });
  }
  return groups;
}

export function groupLimitMessage(count: number): string {
  return `These accounts need ${count} different versions of the post; one generation can write at most ${GROUP_LIMIT}. Choose fewer accounts, or give accounts on the same platform the same posting instructions.`;
}
