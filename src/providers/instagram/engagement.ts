import { z } from "zod";
import type { EngagementReadContext, EngagementReadResult, EngagementSendContext, EngagementSendResult, EngagementSupport, InboundItemDraft } from "../types";
import { graphVersion } from "../meta/config";
import type { MetaCommentSurface, MetaSelfIdentity } from "../meta/engagement-map";
import { metaEngagementStateSchema } from "../meta/engagement-state";
import { metaEngagementRead } from "../meta/engagement-sweep";
import { DEFAULT_GRAPH_BASE, graphRequest } from "../meta/graph";
import type { InstagramSettings } from "./settings";

/** `engagement_items.provider_data` for Instagram: nothing — replying is not built on this surface. */
const engagementItemDataSchema = z.object({}).strict();

/** contracts/meta-comment-surface.md §4. */
export const instagramCommentSurface: MetaCommentSurface = {
  platform: "Instagram",
  // "gets all IG Media on an IG User".
  ownPostsPath: (id) => `/${id}/media`,
  postTimeField: "timestamp",
  commentFields: ["id", "text", "timestamp", "username", "user{id}"],
  commentTextField: "text",
  commentTimeField: "timestamp",
  // This edge documents no `order` and no `filter`, so neither is sent.
  drainParams: {},
  async prefetchSelf({ accountExternalId, token, signal }) {
    const outcome = await graphRequest(
      { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() },
      { method: "GET", path: `/${accountExternalId}`, params: { fields: "username" }, token, signal },
    );
    if (outcome.kind !== "ok") return outcome;
    const body = outcome.body as { username?: unknown } | undefined;
    const selfUsername = typeof body?.username === "string" ? body.username : null;
    if (!selfUsername) return { kind: "unparseable", status: outcome.status, usage: outcome.usage };
    return { kind: "ok", selfUsername };
  },
  mapAuthor(comment): InboundItemDraft["author"] {
    const username = typeof comment.username === "string" && comment.username !== "" ? comment.username : null;
    // `user` is returned only for a comment the requester owns, and such comments are dropped by
    // `isSelf` before mapping — `externalId` is never sourced from it.
    return { displayName: null, handle: username, externalId: null, url: null, identityStable: false };
  },
  isSelf(comment, identity: MetaSelfIdentity): boolean {
    if (identity.selfUsername !== null && comment.username === identity.selfUsername) return true;
    const user = comment.user as { id?: unknown } | undefined;
    return typeof user?.id === "string" && user.id === identity.externalId;
  },
};

async function read(ctx: EngagementReadContext<InstagramSettings>): Promise<EngagementReadResult> {
  return metaEngagementRead(instagramCommentSurface, ctx as EngagementReadContext<unknown>);
}

async function send(_ctx: EngagementSendContext<InstagramSettings>): Promise<EngagementSendResult> {
  return { kind: "fatal_error", error: "This platform cannot be replied to through Docket." };
}

/** Instagram's `engagement` member (contracts/meta-comment-surface.md §4, FR-008). */
export const instagramEngagement: EngagementSupport<InstagramSettings> = {
  declaration: {
    reads: ["comment"],
    canReply: false,
    readScopes: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
    missingReadScopes: {
      reason:
        "This Instagram account needs the instagram_manage_comments permission before Docket can read "
        + "the comments people leave on its posts.",
      docsPath: "meta-setup#engagement",
    },
  },
  itemDataSchema: engagementItemDataSchema,
  stateSchema: metaEngagementStateSchema,
  read,
  send,
};
