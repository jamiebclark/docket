import { mediaConstraintsOf, planImage } from "../media";
import { validateAgainstCapabilities } from "../validation";
import { THREADS_MAX_ITEMS } from "./capabilities";
import type { MediaItem, PostContent, ProviderCapabilities, ValidationIssue } from "../types";

const isVideo = (item: MediaItem) => item.kind === "video";
const isVideoRule = (code: string) => code.startsWith("video_") || code.startsWith("audio_");

/**
 * Shared capability checks with the declared counting rule. The media planner adapts images before publishing,
 * so unadapted-type and oversize files become notes here; geometry the planner would refuse stays blocking.
 * Video is never adapted: its limits are the shared ones with Threads' wording on top. The only Threads-only
 * check is the 20-item total of a mixed carousel.
 */
export function validateThreads(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  const constraints = mediaConstraintsOf(caps);
  const planned = new Map<number, ValidationIssue[]>();
  content.media.forEach((item, i) => {
    if (isVideo(item)) return;
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
    if (isVideoRule(issue.code) && issue.code !== "video_not_accepted") {
      issues.push({ ...issue, message: `${issue.message.replace(/\.$/, "")} for Threads.` });
      continue;
    }
    issues.push(issue);
  }
  for (const list of planned.values()) issues.push(...list);
  const videos = content.media.filter(isVideo).length;
  const n = content.media.length;
  if (videos > 0 && videos < n && n > THREADS_MAX_ITEMS) {
    issues.push({
      severity: "error",
      code: "too_many_items",
      message: `The post has ${n} items; a Threads carousel holds at most ${THREADS_MAX_ITEMS} images and videos together.`,
      field: "media",
      count: n,
      limit: THREADS_MAX_ITEMS,
    });
  }
  return issues;
}
