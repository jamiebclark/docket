import { z } from "zod";
import { MediaSchema } from "@/lib/api/schemas";
import { tagsSchema } from "@/lib/validation/media";
import { discardPreparedUpload, commitUpload, getMedia, listMedia, prepareUpload, type PreparedUpload } from "../../services/media";
import { prepareFromUrl } from "../../services/media-from-url";
import { toApiMedia } from "../../services/views/media";
import { apiError } from "../errors";
import { decodeCursor, pageOf, pageQuerySchema } from "../pagination";
import { defineOperation } from "./types";

const flag = z.stringbool();
const mediaIdParams = z.object({ mediaId: z.uuid() });

function tagList(form: FormData): string[] | undefined {
  const all = form.getAll("tags").filter((v): v is string => typeof v === "string");
  if (all.length === 0) return undefined;
  return all.flatMap((v) => v.split(",")).map((t) => t.trim()).filter(Boolean);
}

const uploadBody = z.preprocess(
  (raw) => {
    if (!(raw instanceof FormData)) return raw;
    const alt = raw.get("altText");
    return { file: raw.get("file") ?? undefined, altText: typeof alt === "string" ? alt : undefined, tags: tagList(raw) };
  },
  z.object({ file: z.file(), altText: z.string().max(2000).optional(), tags: tagsSchema.optional() }),
);

const urlBody = z.object({
  url: z.string().min(1).max(2048),
  altText: z.string().max(2000).optional(),
  tags: tagsSchema.optional(),
});

const meta = (b: { altText?: string | undefined; tags?: string[] | undefined }) => ({
  ...(b.altText !== undefined ? { altText: b.altText } : {}),
  ...(b.tags !== undefined ? { tags: b.tags } : {}),
});

/** Writes the prepared row; removes the stored objects when the row cannot be written. */
async function commit(scope: Parameters<typeof commitUpload>[0], prepared: PreparedUpload, m: ReturnType<typeof meta>) {
  try {
    return await scope.transaction((tx) => commitUpload(tx, prepared, m));
  } catch (err) {
    await discardPreparedUpload(prepared);
    throw err;
  }
}

export const mediaOperations = [
  defineOperation({
    id: "listMedia",
    method: "GET",
    path: "/media",
    permission: "read",
    tag: "Media",
    summary: "List the media library",
    description: "`unused=true` leaves out images that were used in a post or are held by a job.",
    query: pageQuerySchema.extend({ unused: flag.optional(), missingAlt: flag.optional(), tag: z.string().max(50).optional() }),
    responses: { 200: { description: "A page of media", schema: z.object({ data: z.array(MediaSchema), nextCursor: z.string().nullable() }) } },
    idempotent: false,
    async run(scope, { query }) {
      const offset = decodeCursor(query.cursor);
      if (offset === null) throw apiError("validation_failed", "The cursor is not valid.");
      const list = await listMedia(scope, {
        limit: query.limit + 1,
        offset,
        ...(query.unused ? { unused: true } : {}),
        ...(query.missingAlt ? { missingAlt: true } : {}),
        ...(query.tag ? { tag: query.tag } : {}),
      });
      const page = pageOf(list.items, query.limit, offset);
      return { status: 200, body: { data: page.data.map(toApiMedia), nextCursor: page.nextCursor } };
    },
  }),
  defineOperation({
    id: "getMedia",
    method: "GET",
    path: "/media/{mediaId}",
    permission: "read",
    tag: "Media",
    summary: "Get one image",
    params: mediaIdParams,
    resourceParams: ["mediaId"],
    responses: { 200: { description: "The image", schema: MediaSchema }, 404: { description: "Not found" } },
    idempotent: false,
    async run(scope, { params }) {
      return { status: 200, body: toApiMedia(await getMedia(scope, params.mediaId)) };
    },
  }),
  defineOperation({
    id: "uploadMedia",
    method: "POST",
    path: "/media",
    permission: "write_posts",
    tag: "Media",
    summary: "Upload an image",
    description: "multipart/form-data with `file`, and optionally `altText` and `tags` (comma-separated or repeated).",
    body: { kind: "multipart", schema: uploadBody },
    responses: {
      201: { description: "The stored image", schema: MediaSchema },
      413: { description: "Image too large" },
      415: { description: "Not an accepted image type" },
      503: { description: "Media storage is not set up" },
    },
    idempotent: true,
    async prepare(scope, { body }) {
      const bytes = Buffer.from(await body.file.arrayBuffer());
      const prepared = await prepareUpload(scope, { name: body.file.name, bytes });
      if (!("id" in prepared)) {
        const tooBig = prepared.code === "too_large" || prepared.code === "too_many_pixels";
        throw apiError(tooBig ? "payload_too_large" : "unsupported_media_type", prepared.message);
      }
      return prepared;
    },
    async run(scope, { body, prepared }) {
      const row = await commit(scope, prepared as PreparedUpload, meta(body));
      return { status: 201, body: toApiMedia(row) };
    },
  }),
  defineOperation({
    id: "registerMediaFromUrl",
    method: "POST",
    path: "/media/from-url",
    permission: "write_posts",
    tag: "Media",
    summary: "Import an image from a public URL",
    description: "Docket downloads the image. Private, loopback and link-local addresses are refused, including through redirects.",
    body: { kind: "json", schema: urlBody },
    responses: {
      201: { description: "The stored image", schema: MediaSchema },
      400: { description: "The URL is not allowed or could not be fetched" },
      413: { description: "Image too large" },
      415: { description: "Not an accepted image type" },
      503: { description: "Media storage is not set up" },
    },
    idempotent: true,
    prepare: (scope, { body }) => prepareFromUrl(scope, { url: body.url }),
    async run(scope, { body, prepared }) {
      const row = await commit(scope, prepared as PreparedUpload, meta(body));
      return { status: 201, body: toApiMedia(row) };
    },
  }),
];
