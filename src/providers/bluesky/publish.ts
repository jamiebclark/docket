import { AtUri, RichText, XRPCError } from "@atproto/api";
import type { AttemptSummary, PublishContext, StepResult } from "../types";
import { agentFor } from "./client";
import { classify, errorName, rateLimitNotBefore, statusOf, type ErrorKind } from "./errors";
import { buildFacets } from "./facets";
import { blueskyCredentialsSchema, blueskyStateSchema, type BlueskyCredentials, type BlueskyState } from "./settings";
import { mentionHandles, stepForContent } from "./steps";

const POST_COLLECTION = "app.bsky.feed.post";

interface Env {
  ctx: PublishContext;
  pdsUrl: string;
  creds: BlueskyCredentials;
  state: BlueskyState;
}

type Outcome = Exclude<StepResult, { kind: "continue" | "done" }>;

const retryable = (error: string): StepResult => ({ kind: "retryable_error", error });
const fatal = (error: string): StepResult => ({ kind: "fatal_error", error });

/** The request-side summary plus whatever the outcome says about the response. Only the keys of D19. */
function summarise(request: Record<string, unknown>, err?: unknown): AttemptSummary {
  const response: Record<string, unknown> = {};
  if (err !== undefined) {
    const status = statusOf(err);
    if (status !== null && status > 2) response.status = status;
    if (err instanceof XRPCError) {
      response.error = errorName(err);
      const notBefore = status === 429 ? rateLimitNotBefore(err.headers, new Date()) : null;
      if (notBefore) response.retryAfterSeconds = Math.max(0, Math.round((notBefore.getTime() - Date.now()) / 1000));
    }
  }
  return { request, ...(Object.keys(response).length ? { response } : {}) };
}

function failed(err: unknown, kind: ErrorKind, request: Record<string, unknown>, env: Env, index?: number): StepResult {
  const outcome: Outcome = classify(err, kind, env.ctx.now, index);
  return { ...outcome, summary: summarise(request, err) };
}

export async function advance(ctx: PublishContext): Promise<StepResult> {
  try {
    const stateResult = ctx.state === null || ctx.state === undefined ? blueskyStateSchema.safeParse({ v: 1 }) : blueskyStateSchema.safeParse(ctx.state);
    const expected = stepForContent(ctx.state, { text: ctx.content.text, mediaCount: ctx.content.media.length });
    if (!stateResult.success || expected.name === "invalid_state") return fatal("Publishing state is unreadable. Use Retry to start again.");
    if (expected.name !== ctx.step.name) return retryable("The post changed while publishing; will retry.");
    const creds = blueskyCredentialsSchema.safeParse(ctx.account.credentials);
    if (!creds.success) return fatal("Stored credentials are unreadable; reconnect the account.");
    const pdsUrl = (ctx.account.settings as { pdsUrl?: unknown } | null)?.pdsUrl;
    if (typeof pdsUrl !== "string") return fatal("Stored account settings are unreadable; reconnect the account.");

    const env: Env = { ctx, pdsUrl, creds: creds.data, state: stateResult.data };
    if (ctx.step.name === "resolve_mentions") return await resolveMentions(env);
    if (ctx.step.name === "create_post") return await createPost(env);
    return await uploadImage(env);
  } catch {
    // Never throw: an unexpected failure is only safe to retry before the write step.
    return ctx.step.mayPublish
      ? { kind: "ambiguous", error: "Bluesky call failed unexpectedly." }
      : retryable("Bluesky call failed unexpectedly.");
  }
}

async function resolveMentions(env: Env): Promise<StepResult> {
  const { ctx } = env;
  const handles = mentionHandles(ctx.content.text);
  const request = { step: "resolve_mentions", mentionsResolved: 0, mentionsUnresolved: 0 };
  // Unauthenticated: handle resolution is public, and a stale token must not make it fail.
  const agent = agentFor(env.pdsUrl);
  const results = await Promise.all(
    handles.map(async (handle): Promise<{ handle: string; did: string | null } | { err: unknown }> => {
      try {
        const res = await agent.com.atproto.identity.resolveHandle({ handle }, { signal: ctx.signal });
        return { handle, did: res.data.did.startsWith("did:") ? res.data.did : null };
      } catch (err) {
        const status = statusOf(err);
        if (err instanceof XRPCError && status !== null && status >= 400 && status < 500 && status !== 429) return { handle, did: null };
        return { err };
      }
    }),
  );
  const problem = results.find((r): r is { err: unknown } => "err" in r);
  if (problem) return failed(problem.err, "read", request, env);
  const mentions: Record<string, string | null> = { ...(env.state.mentions ?? {}) };
  for (const r of results) if ("handle" in r) mentions[r.handle] = r.did;
  const resolved = results.filter((r) => "did" in r && r.did).length;
  return {
    kind: "continue",
    state: { ...env.state, mentions } satisfies BlueskyState,
    summary: { request: { ...request, mentionsResolved: resolved, mentionsUnresolved: handles.length - resolved } },
  };
}

const MAX_IMAGE_BYTES = 2_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

async function uploadImage(env: Env): Promise<StepResult> {
  const { ctx, state, creds } = env;
  const index = state.blobs.length + 1;
  const item = ctx.content.media[index - 1];
  const request = { step: ctx.step.name, image: index, bytes: item?.bytes ?? 0, mimeType: item?.mimeType ?? "" };
  if (!item) return retryable("The post changed while publishing; will retry.");
  if (!IMAGE_TYPES.has(item.mimeType)) return { ...fatal(`Image ${index} is not a type Bluesky accepts (${item.mimeType}).`), summary: { request } };
  if (item.bytes > MAX_IMAGE_BYTES) return { ...fatal(`Image ${index} is larger than Bluesky allows (2 MB).`), summary: { request } };

  let bytes: Uint8Array;
  try {
    const res = await globalThis.fetch(item.url, { signal: ctx.signal });
    if (!res.ok) return { ...retryable(`Could not read image ${index} (HTTP ${res.status}); will retry.`), summary: { request } };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ...retryable(`Could not read image ${index}; will retry.`), summary: { request } };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ...fatal(`Image ${index} is larger than Bluesky allows (2 MB).`), summary: { request } };

  try {
    const res = await agentFor(env.pdsUrl, creds.accessJwt).com.atproto.repo.uploadBlob(bytes, { encoding: item.mimeType, signal: ctx.signal });
    const blob = res.data.blob.toJSON();
    const parsed = blueskyStateSchema.shape.blobs.unwrap().element.safeParse(blob);
    if (!parsed.success) return { ...retryable(`Bluesky gave an unusable answer for image ${index}; will retry.`), summary: { request, response: { status: 200 } } };
    return {
      kind: "continue",
      state: { ...state, blobs: [...state.blobs, parsed.data] } satisfies BlueskyState,
      summary: { request, response: { status: 200 } },
    };
  } catch (err) {
    return failed(err, "upload", request, env, index);
  }
}

async function createPost(env: Env): Promise<StepResult> {
  const { ctx, state, creds } = env;
  const { text, media } = ctx.content;
  const built = buildFacets(text, state.mentions ?? {});
  const record: Record<string, unknown> = {
    $type: POST_COLLECTION,
    text,
    createdAt: ctx.now.toISOString(),
    ...(built.facets.length ? { facets: built.facets } : {}),
    ...(state.blobs.length
      ? {
          embed: {
            $type: "app.bsky.embed.images",
            images: state.blobs.map((image, i) => {
              const { width, height } = media[i] ?? { width: null, height: null };
              return {
                image,
                alt: media[i]?.altText ?? "",
                ...(width && height ? { aspectRatio: { width, height } } : {}),
              };
            }),
          },
        }
      : {}),
  };
  const request = {
    step: "create_post",
    graphemes: new RichText({ text }).graphemeLength,
    textBytes: Buffer.byteLength(text),
    images: state.blobs.length,
    facets: built.counts,
  };

  let uri: string;
  try {
    const res = await agentFor(env.pdsUrl, creds.accessJwt).com.atproto.repo.createRecord(
      { repo: creds.did, collection: POST_COLLECTION, record },
      { signal: ctx.signal },
    );
    uri = res.data.uri;
  } catch (err) {
    return failed(err, "publish", request, env);
  }

  // D17: a 2xx is only success when the URI names our post.
  let rkey = "";
  try {
    const parsed = new AtUri(uri);
    if (parsed.host === creds.did && parsed.collection === POST_COLLECTION) rkey = parsed.rkey;
  } catch {
    // falls through to ambiguous
  }
  if (!rkey) {
    return { kind: "ambiguous", error: "Bluesky answered without a usable post address.", summary: { request, response: { status: 200 } } };
  }
  return {
    kind: "done",
    externalId: uri,
    url: `https://bsky.app/profile/${creds.handle}/post/${rkey}`,
    summary: { request, response: { status: 200 } },
  };
}
