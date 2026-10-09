import { z } from "zod";
import type { AccountDetailsReader } from "../types";
import { readTikTokCredentials } from "./credentials";
import { readEnvelope, tiktokRequest } from "./http";

/** Live, non-secret creator details (data-model §4). The avatar URL is dropped. */
export const creatorDetailsSchema = z.object({
  v: z.literal(1),
  nickname: z.string().max(200),
  username: z.string().max(100),
  privacyOptions: z.array(z.string().regex(/^[A-Z_]{1,40}$/)).max(10),
  commentDisabled: z.boolean(),
  duetDisabled: z.boolean(),
  stitchDisabled: z.boolean(),
  /** Null = not returned. */
  maxVideoSeconds: z.number().int().min(1).max(36_000).nullable(),
});

export type CreatorDetails = z.infer<typeof creatorDetailsSchema>;

export type CreatorInfoResult =
  | { kind: "ok"; details: CreatorDetails }
  /** `spam_risk_too_many_posts` or `reached_active_user_cap`. */
  | { kind: "cap"; code: string }
  | { kind: "banned" }
  | { kind: "expired" }
  /** Includes `scope_not_authorized` (`code`). */
  | { kind: "refused"; code: string | null }
  | { kind: "rate"; retryAfterMs: number }
  | { kind: "transient" };

const CAP_CODES = new Set(["spam_risk_too_many_posts", "reached_active_user_cap"]);
const DEFAULT_RATE_WAIT_MS = 60_000;

const bool = (v: unknown): boolean => v === true;

function detailsFrom(data: Record<string, unknown>): CreatorDetails | null {
  const options = Array.isArray(data.privacy_level_options) ? data.privacy_level_options : null;
  if (!options || typeof data.creator_username !== "string" && typeof data.creator_nickname !== "string") return null;
  const parsed = creatorDetailsSchema.safeParse({
    v: 1,
    nickname: typeof data.creator_nickname === "string" ? data.creator_nickname.slice(0, 200) : "",
    username: typeof data.creator_username === "string" ? data.creator_username.slice(0, 100) : "",
    privacyOptions: options,
    commentDisabled: bool(data.comment_disabled),
    duetDisabled: bool(data.duet_disabled),
    stitchDisabled: bool(data.stitch_disabled),
    maxVideoSeconds: typeof data.max_video_post_duration_sec === "number" ? data.max_video_post_duration_sec : null,
  });
  return parsed.success ? parsed.data : null;
}

/** `POST /v2/post/publish/creator_info/query/` (contracts/tiktok-publishing.md §3). Never throws. */
export async function readCreatorInfo(accessToken: string, signal: AbortSignal): Promise<CreatorInfoResult> {
  const out = await tiktokRequest({ method: "POST", path: "/v2/post/publish/creator_info/query/", token: accessToken, json: {}, signal });
  if (out.kind === "network" || out.kind === "unparseable") return { kind: "transient" };
  const env = readEnvelope(out.body);
  const code = env.code;
  if (code && CAP_CODES.has(code)) return { kind: "cap", code };
  if (code === "spam_risk_user_banned_from_posting") return { kind: "banned" };
  if (out.kind === "http_error" && out.status === 401 || code === "access_token_invalid") return { kind: "expired" };
  if (code === "scope_not_authorized") return { kind: "refused", code };
  if (out.kind === "http_error" && out.status === 429 || code === "rate_limit_exceeded") {
    return { kind: "rate", retryAfterMs: out.retryAfterMs ?? DEFAULT_RATE_WAIT_MS };
  }
  if (out.kind === "http_error") return out.status >= 500 ? { kind: "transient" } : { kind: "refused", code };
  if (code) return { kind: "refused", code };
  const details = env.data ? detailsFrom(env.data) : null;
  return details ? { kind: "ok", details } : { kind: "transient" };
}

const LOAD_FAILED = "Couldn't load this TikTok account's options.";
const RECONNECT = "TikTok did not grant permission to post. Connect again and allow posting.";

/** G26: the composer's live creator details. `message` is fixed text, so no reply content or secret reaches it. */
export const tiktokAccountDetails: AccountDetailsReader<unknown, CreatorDetails> = {
  schema: creatorDetailsSchema,
  async read({ credentials, signal }) {
    const c = readTikTokCredentials(credentials);
    if (!c) return { ok: false, message: LOAD_FAILED, transient: false };
    const r = await readCreatorInfo(c.accessToken, signal);
    switch (r.kind) {
      case "ok":
        return { ok: true, details: r.details };
      case "expired":
        return { ok: false, message: LOAD_FAILED, credentialsExpired: true, transient: true };
      case "refused":
        return { ok: false, message: r.code === "scope_not_authorized" ? RECONNECT : LOAD_FAILED, transient: false };
      case "banned":
        return { ok: false, message: "TikTok has blocked this account from posting right now.", transient: false };
      case "cap":
        return { ok: false, message: "TikTok's daily posting limit has been reached for this account.", transient: true };
      default:
        return { ok: false, message: LOAD_FAILED, transient: true };
    }
  },
};
