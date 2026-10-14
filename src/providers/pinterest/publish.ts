import type { AttemptSummary, PublishContext, StepResult } from "../types";
import { readPinterestCredentials } from "./credentials";
import { explainPinterest } from "./errors";
import { pinterestRequest, readPinterestMessage } from "./http";
import { pinterestPostingSchema } from "./posting";

const UNREADABLE_CREDENTIALS = "The stored Pinterest sign-in is unreadable. Reconnect the account.";
const BOARD_NOT_CHOSEN = "Choose the board this pin goes on, then schedule again.";
const WRONG_IMAGE_COUNT = "A Pinterest pin needs exactly one image.";
const NO_USABLE_ID = "Pinterest answered without a usable pin id. Check the board on Pinterest before retrying.";
const NOT_SENT = "Could not reach Pinterest; nothing was sent. Will retry.";
const LOST = "The connection to Pinterest was lost after the pin was sent. Check the board on Pinterest before retrying.";
const CREDENTIALS_REJECTED = "Pinterest rejected the sign-in; will renew it and retry.";
const RATE_LIMITED = "Pinterest's rate limit was reached; will retry after it resets.";

const fatal = (error: string): StepResult => ({ kind: "fatal_error", error });

/** `pinUrl(id)` (contracts/pinterest-publishing.md §4). Best-effort; the reply's `link` field is never used. */
export function pinUrl(id: string): string {
  return `https://www.pinterest.com/pin/${encodeURIComponent(id)}/`;
}

/** `now + clamp(resetSeconds, 1, 3600) × 1000` (§5). */
function rateLimitNotBefore(now: Date, resetSeconds: number | null): Date | undefined {
  if (resetSeconds === null) return undefined;
  const clamped = Math.min(Math.max(resetSeconds, 1), 3600);
  return new Date(now.getTime() + clamped * 1000);
}

/** `advancePinterest` — the one step (contracts/pinterest-publishing.md §4). */
export async function advancePinterest(ctx: PublishContext): Promise<StepResult> {
  const creds = readPinterestCredentials(ctx.account.credentials);
  if (!creds) return { kind: "fatal_error", error: UNREADABLE_CREDENTIALS, credentialsInvalid: true };

  const parsedValues = pinterestPostingSchema.safeParse(ctx.content.posting?.values ?? undefined);
  const values = parsedValues.success ? parsedValues.data : null;
  if (!values || values.boardId === null) return fatal(BOARD_NOT_CHOSEN);

  const images = ctx.content.media.filter((m) => (m.kind ?? "image") === "image");
  if (images.length !== 1 || images.length !== ctx.content.media.length) return fatal(WRONG_IMAGE_COUNT);
  const image = images[0]!;

  const secrets = [creds.accessToken, creds.refreshToken];
  const boardName = values.boardName || values.boardId;

  const text = ctx.content.text ?? "";
  const body: Record<string, unknown> = {
    board_id: values.boardId,
    media_source: { source_type: "image_url", url: image.url },
  };
  if (text.trim()) body.description = text;
  if (image.altText.trim()) body.alt_text = image.altText;
  if (values.title) body.title = values.title;
  if (values.link) body.link = values.link;

  const request = {
    step: "create_pin",
    boardId: values.boardId,
    bytes: image.bytes,
    mimeType: image.mimeType,
    descriptionCodePoints: [...text].length,
    hasTitle: !!values.title,
    hasLink: !!values.link,
    hasAltText: !!image.altText.trim(),
  };

  const out = await pinterestRequest({
    method: "POST",
    path: "/v5/pins",
    auth: { kind: "bearer", token: creds.accessToken },
    json: body,
    signal: ctx.signal,
  });

  if (out.kind === "network") {
    return out.phase === "not_sent" ? { kind: "retryable_error", error: NOT_SENT, summary: { request } } : { kind: "ambiguous", error: LOST, summary: { request } };
  }

  if (out.kind === "unparseable") return { kind: "ambiguous", error: NO_USABLE_ID, summary: { request, response: { status: out.status } } };

  if (out.kind === "ok") {
    const id = (out.body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) {
      return { kind: "ambiguous", error: NO_USABLE_ID, summary: { request, response: { status: out.status } } };
    }
    return { kind: "done", externalId: id, url: pinUrl(id), summary: { request, response: { status: out.status, pinId: id } } };
  }

  // out.kind === "http_error"
  const status = out.status;
  const message = readPinterestMessage(out.body);
  const scrubbedMessage = message ? message.slice(0, 200) : undefined;
  const response: AttemptSummary["response"] = {
    status,
    ...(out.rate.remaining !== null ? { rateLimitRemaining: out.rate.remaining } : {}),
    ...(status === 429 && out.rate.resetSeconds !== null ? { retryAfterSeconds: out.rate.resetSeconds } : {}),
    ...(scrubbedMessage ? { message: scrubbedMessage } : {}),
  };
  const summary: AttemptSummary = { request, response };

  if (status === 401) return { kind: "retryable_error", error: CREDENTIALS_REJECTED, credentialsExpired: true, summary };
  if (status === 429) return { kind: "retryable_error", error: RATE_LIMITED, notBefore: rateLimitNotBefore(ctx.now, out.rate.resetSeconds), summary };
  // Every other 4xx is a plain refusal; 5xx (and anything else) is ambiguous — it may have reached Pinterest (K29).
  if (status >= 400 && status < 500) return { kind: "fatal_error", error: explainPinterest(status, message, boardName, secrets), summary };
  return { kind: "ambiguous", error: explainPinterest(status, message, boardName, secrets), summary };
}
