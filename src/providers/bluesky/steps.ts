import { RichText } from "@atproto/api";
import type { StepContent, StepInfo } from "../types";
import { blueskyStateSchema, normaliseHandle } from "./settings";
import { fitState } from "./video-state";

/** Distinct, normalised handles of the mention facets detected in `text`. */
export function mentionHandles(text: string): string[] {
  try {
    const rt = new RichText({ text });
    rt.detectFacetsWithoutResolution();
    const handles = new Set<string>();
    for (const facet of rt.facets ?? []) {
      for (const feature of facet.features) {
        if (feature.$type === "app.bsky.richtext.facet#mention") handles.add(normaliseHandle(String((feature as { did?: unknown }).did ?? "")));
      }
    }
    handles.delete("");
    return [...handles];
  } catch {
    return [];
  }
}

/** Pure and total (data-model §3). */
export function stepForContent(state: unknown, content: StepContent): StepInfo {
  let parsed;
  if (state === null || state === undefined) parsed = blueskyStateSchema.parse({ v: 1 });
  else {
    const result = blueskyStateSchema.safeParse(state);
    if (!result.success) return { name: "invalid_state", mayPublish: false };
    parsed = result.data;
  }
  const mediaCount = Number.isFinite(content.mediaCount) ? Math.max(0, Math.floor(content.mediaCount)) : 0;
  const isVideo = content.kinds?.length === 1 && content.kinds[0] === "video";
  const fitted = fitState(parsed, { isVideo });
  if (fitted.mentions === undefined && mentionHandles(content.text ?? "").length > 0) {
    return { name: "resolve_mentions", mayPublish: false };
  }
  if (!isVideo) {
    if (fitted.blobs.length < mediaCount) return { name: `upload_image_${fitted.blobs.length + 1}`, mayPublish: false };
    return { name: "create_post", mayPublish: true };
  }
  const video = fitted.video;
  switch (video?.phase ?? "limits") {
    case "limits":
      // The allowance is reserved where an upload begins; an hourly re-check of a limit wait reserves nothing (P2).
      return video?.limitWaitSince
        ? { name: "check_upload_limits", mayPublish: false }
        : { name: "check_upload_limits", mayPublish: false, allowance: { units: 1, retryUnits: 0 } };
    case "start":
      return { name: "start_upload", mayPublish: false, allowance: { units: 0, retryUnits: 1 } };
    case "parts":
      return { name: `upload_part_${(video?.partsSent ?? 0) + 1}`, mayPublish: false };
    case "finish":
      return { name: "finish_upload", mayPublish: false };
    case "job":
      return { name: "check_job", mayPublish: false };
    case "ready":
      return { name: "create_post", mayPublish: true };
  }
}
