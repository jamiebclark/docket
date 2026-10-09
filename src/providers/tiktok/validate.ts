import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";
import { validateAgainstCapabilities } from "../validation";
import { tiktokAudited } from "./config";
import type { CreatorDetails } from "./creator";
import { PHOTO_TITLE_MAX, PRIVATE_PRIVACY, privacyLabel, tiktokPostingSchema } from "./posting";

const FALLBACK_NAME = "this TikTok account";

const error = (code: string, field: ValidationIssue["field"], message: string): ValidationIssue => ({ severity: "error", code, message, field });

/** Capability checks with TikTok's own wording, then the posting rules (contracts/tiktok-publishing.md §2). Never throws. */
export function validateTikTok(content: PostContent, caps: ProviderCapabilities, audited: boolean = tiktokAudited()): ValidationIssue[] {
  const issues = validateAgainstCapabilities(content, caps).map((i): ValidationIssue => {
    if (i.code === "video_with_images") return { ...i, message: "TikTok posts a video on its own, without images." };
    if (i.code === "too_many_videos") return { ...i, message: "TikTok takes one video per post." };
    return i;
  });

  const parsed = content.posting?.values == null ? null : tiktokPostingSchema.safeParse(content.posting.values);
  const values = parsed?.success ? parsed.data : null;
  const rawDetails = content.posting?.details;
  const details = rawDetails && typeof rawDetails === "object" ? (rawDetails as CreatorDetails) : null;
  const name = details?.nickname || details?.username || FALLBACK_NAME;
  const videoItem = content.media.findIndex((m) => m.kind === "video");
  const isVideo = content.postType === "video" || (content.postType === undefined && videoItem >= 0);

  if (!values) {
    issues.push(error("posting_required", "posting", "Open this post in the composer to choose TikTok's settings and agree before scheduling."));
  } else {
    const offered = details?.privacyOptions;
    if (values.privacy === null) {
      issues.push(error("privacy_required", "posting.privacy", "Choose who can see this TikTok post."));
    } else if (!audited && values.privacy !== PRIVATE_PRIVACY) {
      issues.push(error("privacy_not_private", "posting.privacy", "This TikTok app is set as not audited, so it can only post privately."));
    } else if (audited && offered && !offered.includes(values.privacy)) {
      issues.push(error("privacy_not_offered", "posting.privacy", `TikTok doesn't offer '${privacyLabel(values.privacy)}' for ${name}. Choose again.`));
    }
    if (!audited && offered && !offered.includes(PRIVATE_PRIVACY)) {
      issues.push(
        error(
          "private_not_offered",
          "posting.privacy",
          `${name} can't post through this app: it only posts privately, and TikTok doesn't offer 'Only me' for this account.`,
        ),
      );
    }
    if (values.brandedContent && values.privacy === PRIVATE_PRIVACY) {
      issues.push(error("branded_private", "posting.privacy", "Branded content can't be private."));
    }
    if (values.disclosure && !values.yourBrand && !values.brandedContent) {
      issues.push(error("disclosure_incomplete", "posting.disclosure", "Choose 'Your brand', 'Branded content' or both."));
    }
    if (values.allowComments && details?.commentDisabled) {
      issues.push(error("interaction_disabled", "posting.allowComments", `${name} has turned off comments on TikTok.`));
    }
    if (isVideo && values.allowDuets && details?.duetDisabled) {
      issues.push(error("interaction_disabled", "posting.allowDuets", `${name} has turned off duets on TikTok.`));
    }
    if (isVideo && values.allowStitches && details?.stitchDisabled) {
      issues.push(error("interaction_disabled", "posting.allowStitches", `${name} has turned off stitches on TikTok.`));
    }
    if (!isVideo && values.photoTitle.length > PHOTO_TITLE_MAX) {
      issues.push(error("photo_title_too_long", "posting.photoTitle", `The photo title is ${values.photoTitle.length} UTF-16 units; TikTok allows ${PHOTO_TITLE_MAX}.`));
    }
  }

  const maxSeconds = details?.maxVideoSeconds;
  if (isVideo && maxSeconds && videoItem >= 0) {
    const seconds = content.media[videoItem]!.video?.durationSeconds;
    if (seconds !== undefined && seconds > maxSeconds) {
      issues.push(error("creator_duration_exceeded", `media.${videoItem}`, `This TikTok account can post videos up to ${maxSeconds} seconds.`));
    }
  }

  if (!isVideo && content.media.some((m) => !/^https:/i.test(m.url))) {
    issues.push(error("photo_url_not_https", "media", "TikTok fetches photos only over HTTPS."));
  }
  return issues;
}
