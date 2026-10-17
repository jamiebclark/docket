import { resolvePostType, postTypeLabel } from "../post-type";
import { aspectLabel } from "../requirements";
import { imageLimitsFor, validateAgainstCapabilities } from "../validation";
import { INSTAGRAM_MAX_IMAGES } from "./capabilities";
import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";

const RATIO_EPSILON = 1e-9;

/**
 * Shared capability checks with Instagram's wording and rules on top. The media planner adapts images before
 * this runs, so the conversion/size notes only fire for media that reaches the provider unadapted.
 */
export function validateInstagram(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = content.postType ?? resolvePostType(caps, content.media, null);
  const typeLabel = postTypeLabel(caps, type);
  const story = type === "story";
  const adaptable = (field: string): boolean => {
    const item = content.media[Number(field.split(".")[1])];
    return !!item && (item.mimeType === "image/png" || item.bytes > caps.media.maxBytesPerFile);
  };

  for (const issue of validateAgainstCapabilities(content, caps)) {
    // PNG and oversize files are converted/compressed before publishing: notes below, not errors.
    if ((issue.code === "mime_not_allowed" || issue.code === "file_too_large") && adaptable(issue.field)) continue;
    // A Story carries no description at all, so asking for one or refusing its length is noise (K11).
    if (story && (issue.code === "missing_alt_text" || issue.code === "alt_text_too_long")) continue;
    if (issue.code === "text_only_not_allowed") {
      issues.push({ ...issue, code: "media_required", message: "Instagram posts need at least one image or video." });
    } else if (issue.code.startsWith("video_") && issue.code !== "video_not_accepted") {
      const message = `${issue.message.replace(/\.$/, "")} for an Instagram ${typeLabel}.`;
      issues.push({ ...issue, message });
    } else {
      issues.push(issue);
    }
  }

  if (story) {
    if (content.text.trim() !== "") {
      issues.push({
        severity: "info",
        code: "story_text_dropped",
        message: "The post text will not appear on an Instagram Story; a Story carries no caption.",
        field: "text",
      });
    }
    content.media.forEach((item, i) => {
      if (item.altText.trim() !== "") {
        issues.push({
          severity: "info",
          code: "story_alt_text_dropped",
          message: "The image description will not appear on an Instagram Story.",
          field: `media.${i}` as const,
        });
      }
    });
    const recommended = caps.media.byPostType?.story?.recommendedAspectRatio;
    content.media.forEach((item, i) => {
      if (item.kind === "video" || recommended === undefined || item.width === null || item.height === null) return;
      const ratio = item.width / item.height;
      if (Math.abs(ratio - recommended) > RATIO_EPSILON) {
        issues.push({
          severity: "info",
          code: "story_will_crop",
          message: `Image ${i + 1} is ${aspectLabel(ratio)}; Instagram will crop it to ${aspectLabel(recommended)} or show blank space. Docket sends it unchanged.`,
          field: `media.${i}` as const,
        });
      }
    });
  }

  if (content.media.length > INSTAGRAM_MAX_IMAGES) {
    issues.push({
      severity: "error",
      code: "too_many_items",
      message: `The post has ${content.media.length} items; Instagram allows ${INSTAGRAM_MAX_IMAGES}.`,
      field: "media",
      count: content.media.length,
      limit: INSTAGRAM_MAX_IMAGES,
    });
  }

  const { minAspectRatio, maxAspectRatio, maxWidth } = imageLimitsFor(caps, type);
  const ratios: number[] = [];
  content.media.forEach((item, i) => {
    const field = `media.${i}` as const;
    const label = `Image ${i + 1}`;
    const video = item.kind === "video";
    if (item.width && item.height) {
      const ratio = item.width / item.height;
      ratios.push(ratio);
      if (video) return;
      const tooTall = minAspectRatio !== undefined && ratio < minAspectRatio - RATIO_EPSILON;
      const tooWide = maxAspectRatio !== undefined && ratio > maxAspectRatio + RATIO_EPSILON;
      if (tooTall || tooWide) {
        issues.push({
          severity: "error",
          code: "aspect_ratio_out_of_range",
          message: `${label} is too ${tooTall ? "tall" : "wide"} for Instagram (aspect ${ratio.toFixed(2)}; allowed ${minAspectRatio}–${maxAspectRatio}).`,
          field,
        });
      }
    }
    if (video) return;
    if (item.mimeType === "image/png") {
      issues.push({ severity: "info", code: "media_will_convert", message: `${label} will be converted to JPEG for Instagram.`, field });
    }
    if (item.bytes > caps.media.maxBytesPerFile) {
      issues.push({ severity: "info", code: "media_will_compress", message: `${label} will be compressed to fit Instagram's size limit.`, field });
    }
    if (maxWidth !== undefined && item.width !== null && item.width > maxWidth) {
      issues.push({ severity: "info", code: "media_will_downscale", message: `${label} will be resized to ${maxWidth}px wide for Instagram.`, field });
    }
  });

  if (ratios.length > 1 && Math.max(...ratios) - Math.min(...ratios) > RATIO_EPSILON) {
    issues.push({
      severity: "info",
      code: "carousel_crop",
      message: "Instagram crops every image in a carousel to the shape of the first one.",
      field: "media",
    });
  }
  return issues;
}
