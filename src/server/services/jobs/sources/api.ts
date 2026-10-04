// jobs/sources/api: one item per entry sent through the public API (research D19).
import { fieldNameSchema, apiSourceInputSchema, type ApiSourceInput } from "@/lib/validation/api";
import { JOB_ITEM_DATA_MAX } from "@/lib/validation/jobs";
import { MediaReservedError, ValidationIssuesError, type ReservedMediaIssue } from "../../../dal/errors";
import type { ProjectScope } from "../../../dal/scope";
import type { ItemSource, PreparedSource, SourceItem } from "./types";

const BRIEF = "Write a post from the details of this item.";

export type ApiItemInput = NonNullable<ApiSourceInput["items"]>[number];

/**
 * Checks items against the job's declared fields and turns them into source items. `base` is the count of items
 * the job already holds, so the default label ("Item 3") follows the item's position. Throws `ValidationIssuesError`
 * naming `items.<i>.fields.<name>` for anything undeclared or too long.
 */
export function prepareApiItems(declared: readonly string[], items: readonly ApiItemInput[], base = 0): SourceItem[] {
  const known = new Set(declared);
  const issues: { code: string; field: string; message: string }[] = [];
  const out = items.map((item, i): SourceItem => {
    let total = 0;
    const fields: Record<string, string> = Object.fromEntries(declared.map((f) => [f, ""]));
    for (const [name, value] of Object.entries(item.fields)) {
      if (!known.has(name)) {
        issues.push({ code: "unknown_field", field: `items.${i}.fields.${name}`, message: `"${name}" is not a field of this job. Declared: ${declared.join(", ") || "none"}` });
        continue;
      }
      fields[name] = value;
      total += value.length;
    }
    if (total > JOB_ITEM_DATA_MAX) {
      issues.push({
        code: "too_long",
        field: `items.${i}.fields`,
        message: `The values total ${total} characters; the limit is ${JOB_ITEM_DATA_MAX.toLocaleString("en-US")}`,
      });
    }
    return { fields, mediaAssetId: item.mediaId ?? null, label: (item.label?.trim() || `Item ${base + i + 1}`).slice(0, 200) };
  });
  if (issues.length > 0) throw new ValidationIssuesError(issues, issues[0]!.message);
  return out;
}

/**
 * Locks the named images and refuses the whole request if any is reserved by another job, repeated in the request,
 * deleted or not in this project. Call inside the transaction that inserts the items.
 */
export async function assertApiMediaAvailable(tx: ProjectScope, items: readonly SourceItem[]): Promise<void> {
  const wanted = items.flatMap((item, index) => (item.mediaAssetId ? [{ index, mediaId: item.mediaAssetId }] : []));
  if (wanted.length === 0) return;
  const ids = [...new Set(wanted.map((w) => w.mediaId))];
  const live = new Set((await tx.media.lockForReservation(ids)).map((m) => m.id));
  const reserved = new Set(await tx.media.reservedAmong([...live]));
  const issues: ReservedMediaIssue[] = [];
  const taken = new Set<string>();
  for (const { index, mediaId } of wanted) {
    if (!live.has(mediaId)) {
      const gone = await tx.media.getIncludingDeleted(mediaId);
      issues.push({ index, mediaId, reason: gone ? "deleted" : "unknown" });
    } else if (reserved.has(mediaId) || taken.has(mediaId)) issues.push({ index, mediaId, reason: "reserved" });
    taken.add(mediaId);
  }
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new MediaReservedError(issues, `Item ${first.index + 1}: the image is ${first.reason === "reserved" ? "already used by another job item" : first.reason === "deleted" ? "deleted" : "not in this project"}.`);
  }
}

export const apiSource: ItemSource<ApiSourceInput> = {
  kind: "api",
  brief: BRIEF,
  inputSchema: apiSourceInputSchema,
  async prepare(_scope, input): Promise<PreparedSource> {
    // Field names must also be unique ignoring case, since placeholders match case-insensitively.
    const seen = new Set<string>();
    for (const name of input.fields) {
      fieldNameSchema.parse(name);
      const key = name.toLowerCase();
      if (seen.has(key)) {
        throw new ValidationIssuesError([{ code: "duplicate_field", field: "source.fields", message: `Field "${name}" is declared twice` }], "Field names must be unique.");
      }
      seen.add(key);
    }
    const items = prepareApiItems(input.fields, input.items ?? []);
    return {
      fields: input.fields,
      items,
      summary: "Items sent through the API",
      meta: { open: input.open === true },
      excluded: [],
      brief: BRIEF,
      // An image the caller named is used even if used before, but never one another job holds.
      mediaRules: { onReserved: "refuse", skipUsed: false },
    };
  },
};
