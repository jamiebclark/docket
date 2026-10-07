// jobs/sources/media: one item per image from the media library (contracts/services.md § Media source).
import { z } from "zod";
import { JOB_ITEMS_MAX, mediaSelectionSchema } from "@/lib/validation/jobs";
import { ValidationIssuesError } from "../../../dal/errors";
import type { MediaRow } from "../../../dal/media";
import type { ItemSource, PreparedSource, SourceItem } from "./types";

export const MEDIA_FIELDS = ["alt_text", "tags", "filename"] as const;
const BRIEF = "Write a post about the attached image.";

export const mediaInputSchema = z.object({ selection: mediaSelectionSchema, includeUsed: z.boolean() });
export type MediaSourceInput = z.infer<typeof mediaInputSchema>;

const clip = (text: string) => (text.length > 200 ? text.slice(0, 200) : text);

function labelOf(row: MediaRow, position: number): string {
  return clip(row.originalFilename?.trim() || row.altText.trim() || `Image ${position + 1}`);
}

export const mediaSource: ItemSource<MediaSourceInput> = {
  kind: "media",
  brief: BRIEF,
  inputSchema: mediaInputSchema,
  async prepare(scope, input): Promise<PreparedSource> {
    const { selection, includeUsed } = input;
    let ids: string[];
    if (selection.mode === "pick") ids = [...new Set(selection.ids)];
    else if (selection.mode === "filter") {
      // List used matches too, so they are counted and reported (and the "include used"
      // option can be offered) rather than silently filtered out in SQL (F2).
      ids = await scope.media.listIdsForSelection({ ...selection.filter, includeUsed: true, limit: JOB_ITEMS_MAX + 1 });
    } else ids = await scope.media.listIdsForSelection({ unusedOnly: true, limit: JOB_ITEMS_MAX + 1 });

    if (ids.length > JOB_ITEMS_MAX) {
      throw new ValidationIssuesError(
        [
          {
            code: "selection",
            field: "selection",
            message: `This selection has ${ids.length > JOB_ITEMS_MAX + 1 ? ids.length : `more than ${JOB_ITEMS_MAX}`} images; a job can hold at most ${JOB_ITEMS_MAX}. Narrow the filter or pick fewer.`,
          },
        ],
        "Too many images.",
      );
    }

    const rows = new Map((await scope.media.getMany(ids)).map((r) => [r.id, r]));
    let deleted = 0;
    let used = 0;
    const kept: MediaRow[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row || row.kind !== "image") deleted++; // a video is never a generator item (FR-045)
      else if (row.firstUsedAt !== null && !(includeUsed && selection.mode !== "unused")) used++;
      else kept.push(row);
    }
    const items: SourceItem[] = kept.map((row, position) => ({
      fields: { alt_text: row.altText, tags: row.tags.join(", "), filename: row.originalFilename ?? "" },
      mediaAssetId: row.id,
      label: labelOf(row, position),
    }));

    const n = items.length;
    const summary =
      selection.mode === "unused"
        ? `${n} unused images`
        : selection.mode === "filter" && selection.filter.tag
          ? `${n} images tagged ${selection.filter.tag}`
          : `${n} selected images`;
    return {
      fields: [...MEDIA_FIELDS],
      items,
      summary,
      meta: { mode: selection.mode, includeUsed },
      excluded: [
        ...(used > 0 ? [{ reason: "already_used" as const, count: used }] : []),
        ...(deleted > 0 ? [{ reason: "deleted" as const, count: deleted }] : []),
      ],
      brief: BRIEF,
    };
  },
};
