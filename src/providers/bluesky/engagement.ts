import { AtUri, XRPCError } from "@atproto/api";
import type { EngagementReadContext, EngagementReadResult, EngagementSendContext, EngagementSendResult, EngagementSupport } from "../types";
import { agentFor } from "./client";
import { isCredentialRejection, rateLimitNotBefore, safeReason } from "./errors";
import { blueskyEngagementItemDataSchema, blueskyEngagementStateSchema, mapBlueskyNotification, type BlueskyEngagementItemData } from "./engagement-map";
import { blueskyCredentialsSchema, type BlueskySettings } from "./settings";

const POST_COLLECTION = "app.bsky.feed.post";
const REASONS = ["reply", "mention"];

/** Reads are `reply`/`mention` only; a `cursor_lost` or credential failure never advances the scheduler's cursor. */
async function read(ctx: EngagementReadContext<BlueskySettings>): Promise<EngagementReadResult> {
  const creds = blueskyCredentialsSchema.safeParse(ctx.account.credentials);
  if (!creds.success) return { kind: "credentials_invalid", error: "Stored Bluesky credentials are unreadable; reconnect the account." };

  try {
    const res = await agentFor(ctx.account.settings.pdsUrl, creds.data.accessJwt).app.bsky.notification.listNotifications(
      { reasons: REASONS, limit: ctx.limit, ...(ctx.cursor ? { cursor: ctx.cursor } : {}) },
      { signal: ctx.signal },
    );
    const items = res.data.notifications
      .filter((n) => n.reason === "reply" || n.reason === "mention")
      .map((n) => mapBlueskyNotification(n));
    return {
      kind: "page",
      items,
      cursor: res.data.cursor ?? null,
      exhausted: !res.data.cursor,
      summary: { request: { reasons: REASONS, limit: ctx.limit }, response: { status: 200, count: items.length } },
    };
  } catch (err) {
    if (!(err instanceof XRPCError)) return { kind: "retryable_error", error: "Could not reach Bluesky; will retry." };
    if (err.status === 429) {
      const retryAt = rateLimitNotBefore(err.headers, ctx.now) ?? undefined;
      return { kind: "rate_limited", error: "Bluesky is rate limiting requests.", ...(retryAt ? { retryAt } : {}) };
    }
    if (isCredentialRejection(err)) return { kind: "credentials_invalid", error: "Bluesky rejected the session; reconnect the account." };
    if (err.status === 400 && (err.error === "InvalidRequest" || err.error === "InvalidCursor")) {
      return { kind: "cursor_lost", error: "Bluesky rejected the read cursor; restarting from the newest notifications." };
    }
    if (err.status >= 500 || err.status <= 2) return { kind: "retryable_error", error: `Bluesky did not give a usable answer (${safeReason(err)}).` };
    return { kind: "fatal_error", error: `Bluesky refused the request (${safeReason(err)}).` };
  }
}

async function send(ctx: EngagementSendContext<BlueskySettings>): Promise<EngagementSendResult> {
  const creds = blueskyCredentialsSchema.safeParse(ctx.account.credentials);
  if (!creds.success) return { kind: "credentials_invalid", error: "Stored Bluesky credentials are unreadable; reconnect the account." };
  const data = blueskyEngagementItemDataSchema.safeParse(ctx.item.data);
  if (!data.success) return { kind: "fatal_error", error: "The original item's reference data is unreadable." };

  const parent = { uri: ctx.item.externalId, cid: data.data.cid };
  const root: BlueskyEngagementItemData["root"] = data.data.root ?? parent;
  const record = {
    $type: POST_COLLECTION,
    text: ctx.text,
    createdAt: ctx.now.toISOString(),
    reply: { root, parent },
  };

  let uri: string;
  try {
    const res = await agentFor(ctx.account.settings.pdsUrl, creds.data.accessJwt).com.atproto.repo.createRecord(
      { repo: creds.data.did, collection: POST_COLLECTION, record },
      { signal: ctx.signal },
    );
    uri = res.data.uri;
  } catch (err) {
    if (!(err instanceof XRPCError)) return { kind: "ambiguous", error: "Bluesky call failed unexpectedly." };
    if (err.status === 429) return { kind: "retryable_error", error: "Bluesky is rate limiting requests.", retryAt: rateLimitNotBefore(err.headers, ctx.now) ?? undefined };
    if (isCredentialRejection(err)) return { kind: "credentials_invalid", error: "Bluesky rejected the session; reconnect the account." };
    if (err.status >= 400 && err.status < 500) return { kind: "fatal_error", error: `Bluesky rejected the reply (${safeReason(err)}).`, flagAccount: isCredentialRejection(err) };
    return { kind: "ambiguous", error: `Bluesky did not give a usable answer (${safeReason(err)}).` };
  }

  try {
    const parsed = new AtUri(uri);
    if (parsed.host === creds.data.did && parsed.collection === POST_COLLECTION) {
      return { kind: "sent", externalId: uri, url: `https://bsky.app/profile/${creds.data.handle}/post/${parsed.rkey}` };
    }
  } catch {
    // falls through to ambiguous
  }
  return { kind: "ambiguous", error: "Bluesky answered without a usable post address." };
}

export const blueskyEngagement: EngagementSupport<BlueskySettings> = {
  declaration: {
    reads: ["reply", "mention"],
    canReply: true,
    /**
     * G41. A reply or mention is itself a post, so it has the same address shape this provider
     * already builds after publishing (`publish.ts`) and after sending a reply above:
     * `https://bsky.app/profile/<handle>/post/<rkey>`.
     *
     * Null without a handle, or when the stored id is not an AT URI naming a post — a guessed link
     * that 404s is worse than none, and the inbox then offers the parent post instead.
     */
    itemUrl: ({ externalId, authorHandle }) => {
      if (!authorHandle) return null;
      try {
        const parsed = new AtUri(externalId);
        if (parsed.collection !== POST_COLLECTION || !parsed.rkey) return null;
        return `https://bsky.app/profile/${authorHandle}/post/${parsed.rkey}`;
      } catch {
        return null;
      }
    },
    writeBudget: { count: 1_666, windowSeconds: 3_600 },
  },
  itemDataSchema: blueskyEngagementItemDataSchema,
  stateSchema: blueskyEngagementStateSchema,
  read,
  send,
};
