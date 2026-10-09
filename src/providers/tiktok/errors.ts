import { docsUrl } from "@/lib/docs";
import { scrubTikTok } from "./http";

export const MESSAGE_MAX = 200;

const SENTENCES: Readonly<Record<string, string>> = {
  unaudited_client_can_only_post_to_private_accounts:
    "TikTok only lets an unaudited app post to a private account. Set the TikTok account to private, or, if your app has passed its audit, check TIKTOK_APP_AUDITED.",
  url_ownership_unverified: `TikTok could not confirm you own the address your photos are served from. Verify your media domain in your TikTok app; see the setup doc (${docsUrl("tiktok-setup", "photo-posts-and-domain-verification")}).`,
  spam_risk_too_many_posts: "TikTok's daily posting limit has been reached for this account.",
  reached_active_user_cap: "TikTok's daily limit on accounts posting through this app has been reached.",
  spam_risk_user_banned_from_posting: "TikTok has blocked this account from posting right now.",
  invalid_param: "TikTok refused the post's settings.",
  file_format_check_failed: "TikTok could not read the video's format.",
  duration_check_failed: "TikTok refused the video's length.",
  frame_rate_check_failed: "TikTok refused the video's frame rate.",
  picture_size_check_failed: "TikTok refused a photo's size.",
  video_pull_failed: "TikTok could not fetch the video.",
  photo_pull_failed: "TikTok could not fetch the photos from your media storage.",
  publish_cancelled: "The post was cancelled on TikTok.",
  auth_removed: "Docket's access was removed in TikTok. Reconnect the account.",
  internal: "TikTok had an internal error and did not post.",
};

const FALLBACK = "TikTok refused the post.";

/**
 * Contract §8: "<sentence> (TikTok: <code>[: <scrubbed message ≤ 200>])". Codes match exactly. The message loses control
 * characters and every secret (tokens, the upload address and its query) before it is cut.
 */
export function explainTikTok(code: string | null, message: string | null, secrets: readonly string[] = []): string {
  const sentence = (code && SENTENCES[code]) || FALLBACK;
  // A reply can carry an address Docket was never issued (so it is not in `secrets`); no message needs a link or its query.
  const cleaned = message ? scrubTikTok(message, secrets).replace(/https?:\/\/\S+/gi, "[link]").replace(/\b(?:upload_id|sig|signature|token)=\S*/gi, "[redacted]").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MESSAGE_MAX) : "";
  const safeCode = code ? scrubTikTok(code, secrets).replace(/[^\w.-]/g, "").slice(0, 80) : "";
  const detail = [safeCode, cleaned].filter(Boolean).join(": ");
  return detail ? `${sentence} (TikTok: ${detail})` : sentence;
}
