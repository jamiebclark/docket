import { countText, countingUnit } from "./text";
import type { PostContent, PostType, ProviderCapabilities, ValidationIssue } from "./types";

export function inferPostType(content: PostContent): "text" | "image" | "carousel" {
  if (content.media.length === 0) return "text";
  return content.media.length === 1 ? "image" : "carousel";
}

/** Issues in a stable order: text, then postType, then media. */
export function validateAgainstCapabilities(
  content: PostContent,
  caps: ProviderCapabilities,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hasText = content.text.trim().length > 0;
  const mediaCount = content.media.length;

  if (!hasText && mediaCount === 0) {
    issues.push({
      severity: "error",
      code: "empty_post",
      message: "The post has no text and no media.",
      field: "text",
    });
  }

  const { countingRule, maxLength } = caps.text;
  const count = countText(content.text, countingRule);
  if (count > maxLength) {
    const unit = countingUnit(countingRule);
    issues.push({
      severity: "error",
      code: "text_too_long",
      message: `Text is ${count} ${unit}; the limit is ${maxLength}.`,
      field: "text",
      count,
      limit: maxLength,
    });
  }

  const postType: PostType = inferPostType(content);
  if (mediaCount === 0 && !caps.textOnlyAllowed && (hasText || !issues.some((i) => i.code === "empty_post"))) {
    issues.push({
      severity: "error",
      code: "text_only_not_allowed",
      message: "This account needs at least one image; text-only posts are not allowed.",
      field: "postType",
    });
  }
  if (mediaCount === 0 && caps.media.required && caps.textOnlyAllowed) {
    issues.push({
      severity: "error",
      code: "media_required",
      message: "This account requires media.",
      field: "media",
    });
  }
  if (mediaCount > 0 && !caps.postTypes.includes(postType)) {
    issues.push({
      severity: "error",
      code: "unsupported_post_type",
      message: `This account does not support ${postType} posts.`,
      field: "postType",
    });
  }

  if (mediaCount > caps.media.maxImages) {
    issues.push({
      severity: "error",
      code: "too_many_images",
      message:
        caps.media.maxImages === 0
          ? "This account does not accept images."
          : `The post has ${mediaCount} images; the limit is ${caps.media.maxImages}.`,
      field: "media",
      count: mediaCount,
      limit: caps.media.maxImages,
    });
  }
  content.media.forEach((item, i) => {
    const field = `media.${i}` as const;
    if (!caps.media.allowedMimeTypes.includes(item.mimeType)) {
      issues.push({
        severity: "error",
        code: "mime_not_allowed",
        message: `Image ${i + 1} is ${item.mimeType}; allowed types are ${caps.media.allowedMimeTypes.join(", ")}.`,
        field,
      });
    }
    if (item.bytes > caps.media.maxBytesPerFile) {
      issues.push({
        severity: "error",
        code: "file_too_large",
        message: `Image ${i + 1} is ${item.bytes} bytes; the limit is ${caps.media.maxBytesPerFile}.`,
        field,
        count: item.bytes,
        limit: caps.media.maxBytesPerFile,
      });
    }
    const maxAlt = caps.media.maxAltTextLength;
    if (maxAlt !== undefined && item.altText.length > maxAlt) {
      issues.push({
        severity: "error",
        code: "alt_text_too_long",
        message: `Image ${i + 1} alt text is ${item.altText.length} characters; the limit is ${maxAlt}.`,
        field,
        count: item.altText.length,
        limit: maxAlt,
      });
    }
    if (item.altText.trim() === "") {
      issues.push({
        severity: "warning",
        code: "missing_alt_text",
        message: `Image ${i + 1} has no alt text.`,
        field,
      });
    }
  });
  return issues;
}
