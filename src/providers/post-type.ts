import type { PostShape, PostType, PostTypeChoice, ProviderCapabilities } from "./types";

type Item = { kind?: "image" | "video" };

export type ItemShape = "none" | "single_image" | "single_video" | "multiple";

export function shapeOf(items: readonly Item[]): ItemShape {
  if (items.length === 0) return "none";
  if (items.length > 1) return "multiple";
  return items[0]!.kind === "video" ? "single_video" : "single_image";
}

/** The choice declared for this shape of content, else null. */
export function choiceFor(caps: ProviderCapabilities | null, items: readonly Item[]): PostTypeChoice | null {
  const shape = shapeOf(items);
  return caps?.postTypeChoices?.find((c) => (c.shape as PostShape) === shape) ?? null;
}

/** Total and never throws. `chosen` only matters for a shape with a declared choice. */
export function resolvePostType(
  caps: ProviderCapabilities | null,
  items: readonly Item[],
  chosen: PostType | null,
): PostType {
  switch (shapeOf(items)) {
    case "none":
      return "text";
    case "single_image":
      return "image";
    case "multiple":
      return "carousel";
    case "single_video": {
      const choice = choiceFor(caps, items);
      if (!choice) return "video";
      return chosen !== null && choice.options.some((o) => o.type === chosen) ? chosen : choice.default;
    }
  }
}

/** Every option type over all choices. */
export function offeredPostTypes(caps: ProviderCapabilities | null): PostType[] {
  const out = new Set<PostType>();
  for (const c of caps?.postTypeChoices ?? []) for (const o of c.options) out.add(o.type);
  return [...out];
}

export function postTypeLabel(caps: ProviderCapabilities | null, type: PostType): string {
  for (const c of caps?.postTypeChoices ?? []) {
    const o = c.options.find((x) => x.type === type);
    if (o) return o.label;
  }
  return type === "carousel" ? "carousel item" : type;
}
