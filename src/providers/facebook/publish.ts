import { graphRequest, DEFAULT_GRAPH_BASE, type MetaApp } from "../meta/graph";
import { graphVersion } from "../meta/config";
import { readPageToken } from "../meta/credentials";
import { graphStepError, graphSummary } from "../meta/errors";
import type { PublishContext, StepResult } from "../types";
import { firstUrl } from "./links";
import { facebookStateSchema, type FacebookState } from "./settings";
import { facebookStepFor } from "./steps";

const PHOTO_SUFFIX = " Images must be at a public URL (see docs/storage.md).";

const fatal = (error: string, extra: Partial<Extract<StepResult, { kind: "fatal_error" }>> = {}): StepResult => ({
  kind: "fatal_error",
  error,
  ...extra,
});

function idOf(body: unknown, key: "id" | "post_id" = "id"): string | null {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Facebook publishing: text/link, one photo, or N unpublished photos attached to one feed post. */
export async function advanceFacebook(ctx: PublishContext, app?: MetaApp): Promise<StepResult> {
  const token = readPageToken(ctx.account.credentials);
  if (!token) return fatal("The stored token is unreadable.", { credentialsInvalid: true });

  const text = ctx.content.text;
  const media = ctx.content.media;
  const parsedState = ctx.state === null ? null : facebookStateSchema.safeParse(ctx.state);
  const state: FacebookState | null = parsedState?.success ? parsedState.data : null;
  const expected = facebookStepFor(ctx.state, { text, mediaCount: media.length });
  if (expected.name !== ctx.step.name || expected.name === "invalid") {
    return fatal("The post changed while publishing.");
  }

  const graph = app ?? { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };
  const page = ctx.account.externalId;
  const name = ctx.step.name;
  const photoIds = state?.photoIds ?? [];

  let path = `/${page}/feed`;
  const params: Record<string, string> = {};
  let upload: number | null = null;
  if (name === "publish_photo") {
    path = `/${page}/photos`;
    params.url = media[0]!.url;
    if (text.length > 0) params.caption = text;
  } else if (name.startsWith("upload_photo_")) {
    upload = Number(name.slice("upload_photo_".length));
    const item = media[upload - 1];
    if (!item) return fatal("The post changed while publishing.");
    path = `/${page}/photos`;
    params.url = item.url;
    params.published = "false";
  } else if (media.length >= 2) {
    if (text.length > 0) params.message = text;
    params.attached_media = JSON.stringify(photoIds.map((id) => ({ media_fbid: id })));
  } else {
    if (text.length > 0) params.message = text;
    const link = firstUrl(text);
    if (link) params.link = link;
  }

  const outcome = await graphRequest(graph, { method: "POST", path, params, token, signal: ctx.signal });
  const isPhotoStep = path.endsWith("/photos");
  const failure = graphStepError(outcome, { mayPublish: ctx.step.mayPublish, platform: "Facebook", secrets: [token] });
  if (failure) {
    if (isPhotoStep && failure.kind === "fatal_error" && !failure.credentialsInvalid) {
      return { ...failure, error: failure.error + PHOTO_SUFFIX };
    }
    return failure;
  }
  if (outcome.kind !== "ok") return fatal("Unexpected Facebook response.");
  const summary = { response: graphSummary(outcome) };

  if (upload !== null) {
    const id = idOf(outcome.body);
    if (!id) return { kind: "retryable_error", error: "Facebook did not return a photo id; trying again.", summary };
    return { kind: "continue", state: { v: 1, photoIds: [...photoIds, id] } satisfies FacebookState, summary };
  }
  const id = name === "publish_photo" ? (idOf(outcome.body, "post_id") ?? idOf(outcome.body)) : idOf(outcome.body);
  if (!id) {
    return { kind: "ambiguous", error: "Facebook accepted the request but its reply could not be read.", summary };
  }
  return { kind: "done", externalId: id, summary };
}
