import { z } from "zod";
import { tagsSchema } from "@/lib/validation/media";
import { ForbiddenError, UrlFetchError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { getEnv } from "../env";
import { fetchPublicResource, type FetchOptions } from "../net/safe-fetch";
import { commitUpload, discardPreparedUpload, prepareUpload, type MediaView, type PreparedUpload } from "./media";

const inputSchema = z.object({
  url: z.string().min(1).max(2048),
  altText: z.string().max(2000).optional(),
  tags: tagsSchema.optional(),
});

let testOverrides: Partial<Pick<FetchOptions, "addressPolicy" | "timeoutMs">> = {};
/** Tests point the fetch at a local server and shorten the timeout. Production never calls this. */
export function setUrlFetchOverridesForTests(overrides: typeof testOverrides): void {
  testOverrides = overrides;
}

const REJECTION_CODES = {
  too_large: "payload_too_large",
  too_many_pixels: "payload_too_large",
} as const;

/** Downloads the image behind a public URL. Throws `UrlFetchError` with a documented code. */
export async function fetchForUpload(
  scope: ProjectScope,
  input: { url: string },
): Promise<{ name: string; bytes: Buffer }> {
  if (!scope.can({ media: ["edit"] })) throw new ForbiddenError();
  const { url } = z.object({ url: z.string().min(1).max(2048) }).parse(input);
  const fetched = await fetchPublicResource(url, { maxBytes: getEnv().media.maxUploadBytes, ...testOverrides });
  const last = new URL(fetched.finalUrl).pathname.split("/").filter(Boolean).pop() ?? "";
  return { name: decodeURIComponent(last) || "image", bytes: fetched.bytes };
}

/** Fetch, process, store, then write the row. A rejected image becomes a `UrlFetchError` (413 or 415). */
export async function prepareFromUrl(scope: ProjectScope, input: { url: string }): Promise<PreparedUpload> {
  const prepared = await prepareUpload(scope, await fetchForUpload(scope, input));
  if (!("id" in prepared)) {
    const code = REJECTION_CODES[prepared.code as keyof typeof REJECTION_CODES] ?? "unsupported_media_type";
    throw new UrlFetchError(code, prepared.message);
  }
  return prepared;
}

export async function registerMediaFromUrl(scope: ProjectScope, input: unknown): Promise<MediaView> {
  const parsed = inputSchema.parse(input);
  const prepared = await prepareFromUrl(scope, parsed);
  try {
    return await scope.transaction((tx) =>
      commitUpload(tx, prepared, {
        ...(parsed.altText !== undefined ? { altText: parsed.altText } : {}),
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
      }),
    );
  } catch (err) {
    await discardPreparedUpload(prepared);
    throw err;
  }
}
