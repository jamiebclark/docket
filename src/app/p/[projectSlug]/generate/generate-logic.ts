// Pure helpers for the Generate screens, kept out of the client component so tests can import them.
import { BRIEF_MAX, INSTRUCTIONS_MAX, SOURCE_TEXT_MAX } from "@/lib/validation/generation";

export interface AccountOption {
  id: string;
  displayName: string;
  providerKey: string;
  providerName: string;
  status: string;
  providerAvailable: boolean;
  maxImages: number;
  mediaRequired: boolean;
}

export const LIMITS = { brief: BRIEF_MAX, sourceText: SOURCE_TEXT_MAX, instructions: INSTRUCTIONS_MAX } as const;

export const counterLabel = (used: number, max: number): string =>
  `${used.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`;

export const freshRequestId = (): string => crypto.randomUUID();

/** Accounts grouped by platform, in the order the platforms first appear. */
export function groupByPlatform(accounts: readonly AccountOption[]): { providerName: string; accounts: AccountOption[] }[] {
  const groups = new Map<string, AccountOption[]>();
  for (const a of accounts) groups.set(a.providerName, [...(groups.get(a.providerName) ?? []), a]);
  return [...groups].map(([providerName, list]) => ({ providerName, accounts: list }));
}

/** The most images any selected platform takes; 0 when nothing is selected. */
export function maxImagesFor(selected: readonly AccountOption[]): number {
  return Math.max(0, ...selected.map((a) => a.maxImages));
}

/** Platforms that need an image when none is chosen (the version for them will go to review). */
export function platformsNeedingImage(selected: readonly AccountOption[], imageCount: number): string[] {
  if (imageCount > 0) return [];
  return [...new Set(selected.filter((a) => a.mediaRequired).map((a) => a.providerName))];
}

export const imageWarning = (providerName: string): string =>
  `${providerName} needs an image. Without one, the ${providerName} version will go to review.`;

export const APPROVAL_LABEL = { review_required: "Review required", auto_approve: "Approve automatically" } as const;
export const SCHEDULING_LABEL = { leave_as_draft: "Leave as draft", add_to_queue: "Add to queue" } as const;
