export function hasActiveSlot(c: { providerAvailable: boolean; active: number }): boolean {
  return c.providerAvailable && c.active >= 1;
}

/** First account (available first) without an active slot, for "Add posting slots" links; null if none. */
export function firstWithoutActiveSlot<T extends { accountId: string; providerAvailable: boolean; active: number }>(
  counts: readonly T[],
): T | null {
  const without = counts.filter((c) => !hasActiveSlot(c));
  return without.find((c) => c.providerAvailable) ?? without[0] ?? null;
}
