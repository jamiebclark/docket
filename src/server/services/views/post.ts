import { generationMetadataSchema } from "@/lib/validation/generation";
import type { ApiPost, ApiTarget } from "@/lib/api/schemas";
import type { AccountRecord } from "../../dal/accounts";
import type { PostRecord } from "../../dal/posts";
import type { TargetRecord } from "../../dal/targets";
import { resolvePostType } from "../../../providers/post-type";
import { findProvider } from "../../../providers/registry";
import { plannedTime } from "../queue";

export interface PostViewInput {
  post: PostRecord;
  targets: readonly TargetRecord[];
  accounts: ReadonlyMap<string, Pick<AccountRecord, "displayName" | "providerKey">>;
  media: readonly { id: string; url: string | null; altText: string; kind?: "image" | "video" }[];
  timeZone: string;
  /** `null` when the creator is unknown (a former member, or no record). */
  createdBy: ApiPost["createdBy"];
}

export function toApiTarget(
  t: TargetRecord,
  account: Pick<AccountRecord, "displayName" | "providerKey"> | undefined,
  timeZone: string,
  items: readonly { kind?: "image" | "video" }[] = [],
): ApiTarget {
  return {
    id: t.id,
    accountId: t.socialAccountId,
    accountName: account?.displayName ?? "Removed account",
    provider: account?.providerKey ?? "",
    status: t.status,
    scheduleKind: t.scheduleKind,
    scheduledAt: t.scheduledAt ? t.scheduledAt.toISOString() : null,
    scheduledAtLocal: t.scheduledAt ? plannedTime(t.scheduledAt, t.slotId, timeZone).localTime : null,
    externalId: t.externalId,
    // Always null today: no provider returns a public URL the API vouches for.
    externalUrl: null,
    attemptCount: t.attemptCount,
    lastError: t.lastError,
    overrideText: t.overrideText,
    postType: resolvePostType(account ? (findProvider(account.providerKey)?.capabilities ?? null) : null, items, t.chosenPostType),
  };
}

/** The one `Post` shape used by API responses and webhook event bodies. */
export function toApiPost(input: PostViewInput): ApiPost {
  const { post } = input;
  const meta = generationMetadataSchema.safeParse(post.generationMetadata);
  const record = meta.success ? meta.data.records[0] : undefined;
  return {
    id: post.id,
    status: post.status,
    reviewState: post.reviewState,
    origin: post.origin,
    text: post.baseText,
    media: input.media.map((m) => ({ id: m.id, url: m.url, altText: m.altText })),
    generation: record
      ? {
          brief: record.inputs.brief,
          voiceProfileId: record.voiceProfile.id,
          decision: record.policies.decision?.reason ?? null,
        }
      : null,
    createdBy: input.createdBy,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    targets: input.targets.map((t) => toApiTarget(t, input.accounts.get(t.socialAccountId), input.timeZone, input.media)),
  };
}
