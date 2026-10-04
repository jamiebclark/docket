import { mediaConstraintsOf, planImage } from "../media";
import { validateAgainstCapabilities } from "../validation";
import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";

/**
 * Shared capability checks with the declared counting rule. The media planner adapts images before publishing,
 * so unadapted-type and oversize files become notes here; geometry the planner would refuse stays blocking.
 * There is no Threads-only blocking check.
 */
export function validateThreads(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  const constraints = mediaConstraintsOf(caps);
  const planned = new Map<number, ValidationIssue[]>();
  content.media.forEach((item, i) => {
    if (!item.width || !item.height) return;
    const plan = planImage(
      { mimeType: item.mimeType, width: item.width, height: item.height, bytes: item.bytes },
      constraints,
      { index: i, platform: "Threads" },
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
  return issues;
}
