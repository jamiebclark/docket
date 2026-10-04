// jobs/sources: the registry of item sources. A new source is one file here and one line below (FR-005).
import { NotFoundError } from "../../../dal/errors";
import { csvSource } from "./csv";
import { mediaSource } from "./media";
import type { ItemSource } from "./types";

export const ITEM_SOURCES: Record<string, ItemSource<unknown>> = {
  media: mediaSource as ItemSource<unknown>,
  csv: csvSource as ItemSource<unknown>,
};

export function sourceFor(kind: string): ItemSource<unknown> {
  const source = Object.hasOwn(ITEM_SOURCES, kind) ? ITEM_SOURCES[kind] : undefined;
  if (!source) throw new NotFoundError();
  return source;
}
