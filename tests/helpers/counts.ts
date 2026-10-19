import { expect } from "vitest";

/**
 * `expect` for a tick section's counts, with the whole counts object in the failure message.
 *
 * Why it exists: `expect(x.counts).toMatchObject({ ambiguous: 1 })` fails as
 * `expected { claimed: 1, done: +0, …(9) } to match object { ambiguous: 1 }` — vitest elides the nine
 * fields that would say what actually happened, and a section's counts are precisely where the
 * explanation lives. Chasing one such failure through `scheduler/refresh.test.ts` took four flake-hunt
 * cycles, and the step that finally cracked it was putting the counts in the message.
 *
 * Passing the counts to this helper rather than hand-writing a second `expect` argument means the
 * expression is evaluated once, so the common `(await tick()).publishing.counts` form needs no
 * hoisting to a local.
 */
export function expectCounts<T extends object>(counts: T) {
  return expect(counts, JSON.stringify(counts));
}

/** The same, for an assertion on one count: the siblings are the context that explains it. */
export function expectCount<T extends object, K extends keyof T>(counts: T, key: K) {
  return expect(counts[key], `${String(key)} of ${JSON.stringify(counts)}`);
}
