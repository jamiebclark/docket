/**
 * The per-run page/bound/backfill policy for reading one account's engagement feed
 * (data-model.md §7). Pure: no I/O, no clock reads beyond what is passed in.
 */

export interface PagingPolicy {
  /** `ENGAGEMENT_READ_PAGES_PER_RUN` */
  pagesPerRun: number;
  /** `ENGAGEMENT_READ_PAGE_SIZE` */
  pageSize: number;
}

/** `backfilling` continues older; otherwise the newest page is read (data-model.md §7 step 2). */
export function directionFor(backfilling: boolean): "newest" | "older" {
  return backfilling ? "older" : "newest";
}

/**
 * Whether another page may be read this run: at most `pagesPerRun` pages, and only while the
 * remaining tick budget would cover another provider call (data-model.md §7 step 3).
 */
export function shouldReadAnotherPage(input: {
  pagesReadSoFar: number;
  policy: PagingPolicy;
  remainingBudgetMs: number;
  providerTimeoutMs: number;
}): boolean {
  if (input.pagesReadSoFar >= input.policy.pagesPerRun) return false;
  return input.remainingBudgetMs >= input.providerTimeoutMs;
}

/**
 * Whether the next run should continue backfilling older pages: a page that came back full with no
 * item already stored means there is more unread history beyond it; nothing is skipped, and the
 * oldest unread is drained first (data-model.md §7 step 5).
 */
export function nextBackfillState(input: {
  wasBackfilling: boolean;
  pageItemCount: number;
  pageSize: number;
  anyAlreadyStored: boolean;
  exhausted: boolean;
}): boolean {
  if (input.exhausted) return false;
  if (input.wasBackfilling) return !input.anyAlreadyStored || input.pageItemCount >= input.pageSize;
  return input.pageItemCount >= input.pageSize && !input.anyAlreadyStored;
}
