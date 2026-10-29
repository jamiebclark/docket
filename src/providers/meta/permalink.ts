import { graphRequest, type MetaApp } from "./graph";

/**
 * The published post's address on the platform, fetched after it exists.
 *
 * Pinterest, X and Bluesky have always returned a `url` from `publish`, so `post_targets.external_url`
 * is set for them and every surface that offers "view it on the platform" works. Facebook and
 * Instagram never did, so that column is null for every Meta post ever published here — which is why
 * the Posts page shows no link for them, and why an Instagram comment in the inbox has nothing to
 * point at.
 *
 * Neither platform returns the address in the publish reply, so it takes one more read:
 *
 * - IG Media: `permalink` — "a permanent URL to the media", a public field.
 *   https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/
 *   (Not available on a child of an album; Docket asks about the parent it just published.)
 * - Page post: `permalink_url` — "the permanent static URL to the post on www.facebook.com".
 *   https://developers.facebook.com/docs/graph-api/reference/post
 * - Threads media: `permalink` — the permanent URL to the post, `https://www.threads.net/@<user>/post/<id>`.
 *   https://developers.facebook.com/docs/threads/posts/
 *
 * Facebook **Reels** are the one gap left. A Reel publish answers with a video id, and the Video node's
 * documented read fields do not include `permalink_url`
 * (https://developers.facebook.com/docs/graph-api/reference/video/), so there is no field here that can
 * be asked for honestly. Asking anyway would cost a request per Reel to get `null` back. Left alone
 * deliberately; `docs/research/meta.md` carries the open question.
 *
 * **Best effort, always.** The post is already published and its id is already known by the time
 * this runs; a missing address is a cosmetic loss. So every failure answers `null` and the publish
 * stays `done` — never an ambiguous or failed target over a link. The same reason it does not throw.
 */
export async function fetchPermalink(
  app: MetaApp,
  input: { id: string; field: "permalink" | "permalink_url"; token: string; signal: AbortSignal },
): Promise<string | null> {
  try {
    const outcome = await graphRequest(app, {
      method: "GET",
      path: `/${input.id}`,
      params: { fields: input.field },
      token: input.token,
      signal: input.signal,
    });
    if (outcome.kind !== "ok") return null;
    const value = (outcome.body as Record<string, unknown> | null)?.[input.field];
    // Only an http(s) address. A platform that answers with something else is not worth storing,
    // and `post_targets.external_url` is rendered as a link wherever it is shown.
    if (typeof value !== "string" || !/^https:\/\//.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}
