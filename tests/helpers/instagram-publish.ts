import { metaSetup } from "./facebook-publish";
import type { MemoryStorage } from "./storage";

export const IG_ID = "17841400000000000";

/** A project with a connected Instagram account and one due target carrying `imageCount` JPEGs. */
export function instagramSetup(storage: MemoryStorage, text: string, imageCount: number) {
  return metaSetup("instagram", IG_ID, storage, text, imageCount);
}
