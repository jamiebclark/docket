import { z } from "zod";
import type { EngagementReadContext, EngagementReadResult, EngagementSendContext, EngagementSendResult, EngagementSupport, InboundItemDraft } from "../types";
import { metaEngagementStateSchema } from "../meta/engagement-state";
import type { MetaCommentSurface, MetaSelfIdentity } from "../meta/engagement-map";
import { metaEngagementRead } from "../meta/engagement-sweep";
import type { FacebookSettings } from "./settings";

/** `engagement_items.provider_data` for Facebook: nothing — replying is not built on this surface. */
const engagementItemDataSchema = z.object({}).strict();

/** contracts/meta-comment-surface.md §3. */
export const facebookCommentSurface: MetaCommentSurface = {
  platform: "Facebook",
  // The edge that "shows only the posts that were published by this page", never /feed.
  ownPostsPath: (id) => `/${id}/posts`,
  postTimeField: "created_time",
  commentFields: ["id", "message", "created_time", "from{name,id}"],
  commentTextField: "message",
  commentTimeField: "created_time",
  drainParams: { order: "reverse_chronological", filter: "toplevel" },
  // The Page id Docket already holds is the identity it needs; no prefetch required.
  prefetchSelf: null,
  mapAuthor(comment): InboundItemDraft["author"] {
    const from = comment.from as { name?: unknown; id?: unknown } | undefined;
    const displayName = typeof from?.name === "string" && from.name !== "" ? from.name : null;
    const externalId = typeof from?.id === "string" && from.id !== "" ? from.id : null;
    return { displayName, handle: null, externalId, url: null, identityStable: externalId !== null };
  },
  isSelf(comment, identity: MetaSelfIdentity): boolean {
    const from = comment.from as { id?: unknown } | undefined;
    return from?.id === identity.externalId;
  },
};

async function read(ctx: EngagementReadContext<FacebookSettings>): Promise<EngagementReadResult> {
  return metaEngagementRead(facebookCommentSurface, ctx as EngagementReadContext<unknown>);
}

async function send(_ctx: EngagementSendContext<FacebookSettings>): Promise<EngagementSendResult> {
  return { kind: "fatal_error", error: "This platform cannot be replied to through Docket." };
}

/** Facebook's `engagement` member (contracts/meta-comment-surface.md §3, FR-008). */
export const facebookEngagement: EngagementSupport<FacebookSettings> = {
  declaration: {
    reads: ["comment"],
    canReply: false,
    readScopes: ["pages_read_engagement", "pages_read_user_content"],
    missingReadScopes: {
      reason:
        "A Facebook Page needs the pages_read_user_content permission before Docket can read the "
        + "comments people leave on its posts. Reconnect the Page to grant it.",
      docsPath: "meta-setup#engagement",
    },
  },
  itemDataSchema: engagementItemDataSchema,
  stateSchema: metaEngagementStateSchema,
  read,
  send,
};
