import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";
import { validateAgainstCapabilities } from "../validation";
import type { PinterestDetails } from "./boards";
import { PINTEREST_LINK_MAX, PINTEREST_TITLE_MAX, pinterestPostingSchema } from "./posting";

const error = (code: string, field: ValidationIssue["field"], message: string, count?: number, limit?: number): ValidationIssue => ({
  severity: "error",
  code,
  message,
  field,
  ...(count !== undefined && limit !== undefined ? { count, limit } : {}),
});

const CAPABILITY_MESSAGES: Readonly<Record<string, string>> = {
  text_only_not_allowed: "Pinterest needs one image: there is no text-only pin.",
  media_required: "Pinterest needs one image: there is no text-only pin.",
  unsupported_post_type: "Pinterest takes one image per pin; carousels are not supported yet.",
};

/** Whether the media planner converts or compresses this item instead of the provider refusing it (contracts §1). */
function adaptable(content: PostContent, caps: ProviderCapabilities, field: string): boolean {
  const item = content.media[Number(field.split(".")[1])];
  return !!item && (!caps.media.allowedMimeTypes.includes(item.mimeType) || item.bytes > caps.media.maxBytesPerFile);
}

function reword(issue: ValidationIssue): ValidationIssue {
  if (issue.code === "text_too_long") {
    return { ...issue, message: `The post's text becomes the pin's description: ${issue.count} characters; Pinterest allows 800.` };
  }
  if (issue.code === "too_many_images") {
    return { ...issue, message: `This post has ${issue.count} images; a Pinterest pin takes exactly one.` };
  }
  const message = CAPABILITY_MESSAGES[issue.code];
  return message ? { ...issue, message } : issue;
}

const ABSOLUTE_HTTP = /^https?:\/\/\S+/i;

/** contracts/pinterest-publishing.md §2. Pure, never throws. */
export function validatePinterest(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  const issues = validateAgainstCapabilities(content, caps)
    .filter((issue) => !((issue.code === "mime_not_allowed" || issue.code === "file_too_large") && adaptable(content, caps, issue.field)))
    .map(reword);

  const parsed = content.posting?.values == null ? null : pinterestPostingSchema.safeParse(content.posting.values);
  const values = parsed?.success ? parsed.data : null;
  const rawDetails = content.posting?.details;
  const details = rawDetails && typeof rawDetails === "object" ? (rawDetails as PinterestDetails) : null;

  if (!values) {
    issues.push(error("posting_required", "posting", "Open this post in the composer and choose a Pinterest board before scheduling."));
  } else {
    if (details && details.boards.length === 0) {
      issues.push(error("no_boards", "posting.boardId", "This Pinterest account has no public boards. Create one on Pinterest, then choose it here."));
    } else if (values.boardId === null) {
      issues.push(error("board_required", "posting.boardId", "Choose the board this pin goes on."));
    } else if (details && !details.boards.some((b) => b.id === values.boardId)) {
      issues.push(
        error("board_not_found", "posting.boardId", `The board "${values.boardName || values.boardId}" is no longer on Pinterest. Choose another.`),
      );
    }

    if (values.title.length > PINTEREST_TITLE_MAX) {
      issues.push(
        error("title_too_long", "posting.title", `The pin title is ${values.title.length} characters; Pinterest allows ${PINTEREST_TITLE_MAX}.`, values.title.length, PINTEREST_TITLE_MAX),
      );
    }
    if (values.link.length > PINTEREST_LINK_MAX) {
      issues.push(
        error("link_too_long", "posting.link", `The pin link is ${values.link.length} characters; Pinterest allows ${PINTEREST_LINK_MAX}.`, values.link.length, PINTEREST_LINK_MAX),
      );
    } else if (values.link && !ABSOLUTE_HTTP.test(values.link)) {
      issues.push(error("link_invalid", "posting.link", "The pin link must be a full web address starting with https://."));
    }
  }

  const image = content.media[0]?.mimeType.startsWith("image/") ? content.media[0] : undefined;
  if (image && image.width !== null && image.height !== null) {
    const ratio = image.width / image.height;
    if (ratio < 0.5 || ratio > 1.0) {
      issues.push({
        severity: "warning",
        code: "aspect_far_from_recommended",
        field: "media.0",
        message: `Image 1 is ${image.width} wide by ${image.height} tall; Pinterest recommends 2:3 and may crop it in the feed. It will still be published.`,
      });
    }
  }
  if (image && !/^https:/i.test(image.url)) {
    issues.push(error("image_url_not_https", "media", "Pinterest fetches the image over HTTPS only."));
  }

  return issues;
}
