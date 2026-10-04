import { RichText } from "@atproto/api";
import type { StepContent, StepInfo } from "../types";
import { blueskyStateSchema, normaliseHandle } from "./settings";

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

/** Pure and total (data-model §4). */
export function stepForContent(state: unknown, content: StepContent): StepInfo {
  let parsed;
  if (state === null || state === undefined) parsed = blueskyStateSchema.parse({ v: 1 });
  else {
    const result = blueskyStateSchema.safeParse(state);
    if (!result.success) return { name: "invalid_state", mayPublish: false };
    parsed = result.data;
  }
  const mediaCount = Number.isFinite(content.mediaCount) ? Math.max(0, Math.floor(content.mediaCount)) : 0;
  if (parsed.mentions === undefined && mentionHandles(content.text ?? "").length > 0) {
    return { name: "resolve_mentions", mayPublish: false };
  }
  if (parsed.blobs.length < mediaCount) return { name: `upload_image_${parsed.blobs.length + 1}`, mayPublish: false };
  return { name: "create_post", mayPublish: true };
}
