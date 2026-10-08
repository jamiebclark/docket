import { validateAgainstCapabilities } from "../validation";
import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";

const MAX_TEXT_BYTES = 3000;

export function validateBluesky(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  const issues = validateAgainstCapabilities(content, caps).map((issue) => {
    if (issue.code === "too_many_videos") {
      return { ...issue, message: `Bluesky takes one video per post; this post has ${issue.count}.` };
    }
    if (issue.code === "video_with_images") {
      return { ...issue, message: "Bluesky takes one video per post with no images alongside it." };
    }
    return issue;
  });
  const bytes = Buffer.byteLength(content.text, "utf8");
  if (bytes > MAX_TEXT_BYTES) {
    issues.push({
      severity: "error",
      code: "text_too_many_bytes",
      field: "text",
      count: bytes,
      limit: MAX_TEXT_BYTES,
      message: `Text is ${bytes} bytes; Bluesky allows at most ${MAX_TEXT_BYTES} bytes.`,
    });
  }
  return issues;
}
