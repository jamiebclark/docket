import { z } from "zod";
import type { InboundItemDraft } from "../types";

/** `engagement_items.provider_data` for Bluesky: the strong refs a reply needs (research.md §6). */
export const blueskyEngagementItemDataSchema = z.object({
  cid: z.string(),
  root: z.object({ uri: z.string(), cid: z.string() }).optional(),
});
export type BlueskyEngagementItemData = z.infer<typeof blueskyEngagementItemDataSchema>;

/** `engagement_account_states.provider_state` for Bluesky: a backfill cursor, nothing else. */
export const blueskyEngagementStateSchema = z.object({
  backfillCursor: z.string().optional(),
});
export type BlueskyEngagementState = z.infer<typeof blueskyEngagementStateSchema>;

/** The shape the installed `@atproto/api` client returns from `listNotifications`, narrowed to what mapping reads. */
export interface BlueskyNotification {
  uri: string;
  cid: string;
  reason: string;
  reasonSubject?: string;
  author: { did: string; handle: string; displayName?: string };
  record: unknown;
  indexedAt: string;
}

interface ReplyRecord {
  text?: unknown;
  createdAt?: unknown;
  reply?: { root?: { uri?: unknown; cid?: unknown }; parent?: { uri?: unknown; cid?: unknown } };
}

function asReplyRecord(record: unknown): ReplyRecord {
  return typeof record === "object" && record !== null ? (record as ReplyRecord) : {};
}

/**
 * Maps one `listNotifications` notification (reason `reply` or `mention` only) to an
 * `InboundItemDraft` (contracts/provider-engagement.md's Bluesky row). Never calls the network and
 * never throws: an unreadable record falls back to an empty text and the notification's own `uri`.
 */
export function mapBlueskyNotification(n: BlueskyNotification): InboundItemDraft {
  const record = asReplyRecord(n.record);
  const text = typeof record.text === "string" ? record.text : "";
  const saidAt = typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt)) ? new Date(record.createdAt) : new Date(n.indexedAt);
  const parentExternalId = n.reasonSubject ?? (typeof record.reply?.parent?.uri === "string" ? record.reply.parent.uri : null);
  const root =
    typeof record.reply?.root?.uri === "string" && typeof record.reply?.root?.cid === "string"
      ? { uri: record.reply.root.uri, cid: record.reply.root.cid }
      : undefined;

  return {
    kind: n.reason === "mention" ? "mention" : "reply",
    externalId: n.uri,
    text,
    author: {
      displayName: n.author.displayName ?? null,
      handle: n.author.handle ?? null,
      externalId: n.author.did,
      url: `https://bsky.app/profile/${n.author.handle}`,
      identityStable: true,
    },
    saidAt,
    parentExternalId,
    data: { cid: n.cid, ...(root ? { root } : {}) } satisfies BlueskyEngagementItemData,
  };
}
