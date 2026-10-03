import type { MediaItem, PostContent } from "../../../providers/types";
import { inferPostType } from "../../../providers/validation";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";

export { inferPostType };

/** Effective content of a target: `override_text ?? base_text` plus the post's media in order. */
export async function effectiveContent(tx: Pick<ProjectScope, "targets">, target: TargetRecord): Promise<PostContent | null> {
  const content = await tx.targets.effectiveContent(target.id);
  if (!content) return null;
  const media: MediaItem[] = content.media.map((m) => ({ ...m }));
  return { text: content.text, media };
}
