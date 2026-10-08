import { postTypeLabel, resolvePostType } from "../post-type";
import { validateAgainstCapabilities } from "../validation";
import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";

const SUGGESTION = " Post it as a Page video instead.";

const isVideoRule = (code: string) => code.startsWith("video_") || code.startsWith("audio_");

/** Shared capability checks with Facebook's wording on top; the composer, scheduling gate and engine all call this. */
export function validateFacebook(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  const type = content.postType ?? resolvePostType(caps, content.media, null);
  const typeLabel = postTypeLabel(caps, type);
  const issues = validateAgainstCapabilities(content, caps);

  // Only a single-video Reel can be offered the Page video route, and only if that route would take the file.
  const suggest =
    type === "reel" &&
    content.media.length === 1 &&
    !validateAgainstCapabilities({ ...content, postType: "video" }, caps).some(
      (i) => i.severity === "error" && isVideoRule(i.code),
    );

  return issues.map((issue) => {
    if (issue.code === "too_many_videos" || issue.code === "video_with_images") {
      return { ...issue, message: "A Facebook post can carry one video and no images." };
    }
    if (!isVideoRule(issue.code) || issue.code === "video_not_accepted") return issue;
    const message =
      issue.code === "video_aspect_out_of_range" && type === "reel"
        ? `${issue.message.split(";")[0]}; Facebook Reels must be 9:16 (vertical). Docket does not crop video yet.`
        : `${issue.message.replace(/\.$/, "")} for a Facebook ${typeLabel}. Docket does not crop, trim or convert video yet.`;
    return { ...issue, message: suggest && issue.severity === "error" ? message + SUGGESTION : message };
  });
}
