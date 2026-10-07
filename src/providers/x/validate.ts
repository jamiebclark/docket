import { mediaConstraintsOf, planImage } from "../media";
import { validateAgainstCapabilities } from "../validation";
import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";
import { X_COUNT_WARNING_THRESHOLD } from "./config";
import { countXText, hasLinkOrEmoji } from "./text";

/**
 * Shared capability checks with the x-weighted rule. The media planner adapts images before publishing, so an
 * unaccepted type or oversize file becomes a note here; geometry the planner would refuse stays blocking.
 * The one X-only check is a warning, never a block (research D8).
 */
export function validateX(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  const constraints = mediaConstraintsOf(caps);
  const planned = new Map<number, ValidationIssue[]>();
  content.media.forEach((item, i) => {
    if (!item.width || !item.height) return;
    const plan = planImage(
      { mimeType: item.mimeType, width: item.width, height: item.height, bytes: item.bytes },
      constraints,
      { index: i, platform: "X" },
    );
    if (plan.kind === "refuse") planned.set(i, plan.issues);
    else if (plan.kind === "derive") planned.set(i, plan.notes);
  });

  const adaptable = (field: string): boolean => {
    const i = Number(field.split(".")[1]);
    const item = content.media[i];
    return !!item && !(planned.get(i) ?? []).some((n) => n.severity === "error");
  };

  const issues: ValidationIssue[] = [];
  for (const issue of validateAgainstCapabilities(content, caps)) {
    if ((issue.code === "mime_not_allowed" || issue.code === "file_too_large") && adaptable(issue.field)) continue;
    issues.push(issue);
  }
  for (const list of planned.values()) issues.push(...list);

  const count = countXText(content.text);
  if (count > X_COUNT_WARNING_THRESHOLD && hasLinkOrEmoji(content.text)) {
    issues.push({
      severity: "warning",
      code: "x_count_may_differ",
      message: "X counts links and emoji its own way; this post is close to the 280 limit and X's count may differ slightly.",
      field: "text",
      count,
      limit: caps.text.maxLength,
    });
  }
  return issues;
}
