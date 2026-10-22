/**
 * The one vocabulary for inbound engagement kinds. Pure, so the inbox filter, the activity message
 * and the notification email all call a comment a comment.
 *
 * `OUTCOME_LABEL.engagement` is "New replies" (077, contracts/vocabulary.md §2) — the badge for the
 * whole outcome class. A comment, a mention and a DM all land in that class, so anything that names
 * one *item* has to name its kind instead, or it tells somebody "reply" about a comment.
 */

export const ENGAGEMENT_ITEM_KINDS = ["reply", "comment", "mention", "direct_message"] as const;
export type EngagementItemKind = (typeof ENGAGEMENT_ITEM_KINDS)[number];

/** Title case, for a badge or a filter option. */
export const ENGAGEMENT_KIND_LABEL: Record<EngagementItemKind, string> = {
  reply: "Reply",
  comment: "Comment",
  mention: "Mention",
  direct_message: "Direct message",
};

/** Lower case, for the middle of a sentence: "1 new comment". */
const NOUN: Record<EngagementItemKind, { one: string; many: string }> = {
  reply: { one: "reply", many: "replies" },
  comment: { one: "comment", many: "comments" },
  mention: { one: "mention", many: "mentions" },
  direct_message: { one: "direct message", many: "direct messages" },
};

export function isEngagementItemKind(value: unknown): value is EngagementItemKind {
  return typeof value === "string" && (ENGAGEMENT_ITEM_KINDS as readonly string[]).includes(value);
}

/** "2 comments", "1 mention" — the count and its noun, agreeing. */
export function engagementKindPhrase(kind: EngagementItemKind, count: number): string {
  const noun = NOUN[kind];
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}

/** "a, b and c" — the one list shape, shared with the email subject so lists never drift in style. */
export function joinPhrases(phrases: string[]): string {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0]!;
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]!}`;
}

/**
 * What an activity row says a read brought in: "1 new comment", "2 new comments and 1 mention".
 *
 * Kinds are listed in the declared order and not by count, so the same mix always reads the same
 * way. "new" is carried by the first phrase only — it governs the whole list.
 */
export function engagementItemsMessage(counts: Partial<Record<EngagementItemKind, number>>): string {
  const present = ENGAGEMENT_ITEM_KINDS.filter((kind) => (counts[kind] ?? 0) > 0);
  if (present.length === 0) return "0 new items";
  return joinPhrases(
    present.map((kind, index) => {
      const count = counts[kind]!;
      const noun = NOUN[kind];
      return `${count} ${index === 0 ? "new " : ""}${count === 1 ? noun.one : noun.many}`;
    }),
  );
}
