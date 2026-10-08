/** Plain explanations of Bluesky's video refusals (publishing contract §7). Matched exactly on the code. */

const MAX_MESSAGE_CHARS = 200;

/** Control characters out, every secret replaced, at most 200 characters (P17). */
export function sanitiseMessage(text: string | null | undefined, secrets: readonly string[] = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  out = out.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS - 1)}…` : out;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A code taken from a Bluesky reply: kept as is when it looks like a code, otherwise cleaned like a message. */
export function sanitiseCode(code: string | null | undefined, secrets: readonly string[] = []): string {
  if (code && SAFE_CODE.test(code) && !secrets.some((s) => s && code.includes(s))) return code;
  return sanitiseMessage(code, secrets);
}

const START_REFUSALS: Readonly<Record<string, string>> = {
  UnsupportedContentType: "it is not an MP4 file Bluesky accepts",
  VideoTooLarge: "it is over Bluesky's 300 MB limit",
  VideoTooLong: "it is longer than Bluesky allows; Docket cuts videos to 3 minutes for Bluesky, so Bluesky's limit is lower than expected",
  BadAspectRatio: "Bluesky does not accept its shape",
  UploadForbidden: "Bluesky does not allow this account to upload video; accounts hosted by Bluesky must verify their email address first",
};

const JOB_FAILURES: Readonly<Record<string, string>> = {
  validation_failure: "Bluesky found the file invalid",
  encoding_failure: "Bluesky could not process the file's encoding",
  pds_upload_failure: "Bluesky's video service could not store the video on the account's server; try again later",
  pds_upload_unsupported_blob_size: "the account's server does not accept a file this large (common on self-hosted servers)",
  generic_failure: "Bluesky could not process the video",
};

/** `(<code>: <message>)`, dropping `: <message>` when Bluesky sent none. */
const codeAndMessage = (code: string, message: string) => (message ? `${code}: ${message}` : code);

export const isStartRefusal = (code: string | null | undefined): boolean => !!code && Object.hasOwn(START_REFUSALS, code);

export function startRefusalText(code: string, message: string | null | undefined, secrets: readonly string[] = []): string {
  const clean = sanitiseMessage(message, secrets);
  return `Bluesky refused the video: ${START_REFUSALS[code] ?? "it was not accepted"} (${codeAndMessage(code, clean)}). Nothing was published.`;
}

export function jobFailureText(failureCode: string | null | undefined, message: string | null | undefined, secrets: readonly string[] = []): string {
  const clean = sanitiseMessage(message, secrets);
  const code = sanitiseCode(failureCode, secrets);
  if (code && Object.hasOwn(JOB_FAILURES, code)) {
    return `Bluesky could not process the video: ${JOB_FAILURES[code]} (${codeAndMessage(code, clean)}). Nothing was published.`;
  }
  return `Bluesky could not process the video (${codeAndMessage(code || "no code", clean)}). Nothing was published.`;
}

const DEFAULT_LIMIT_MESSAGE = "Bluesky's daily video upload limit has been reached for this account";

export function limitWaitText(message: string | null | undefined, secrets: readonly string[] = []): string {
  return `${limitMessage(message, secrets)}. Docket checks again in an hour; nothing was uploaded.`;
}

export function limitFailureText(message: string | null | undefined, secrets: readonly string[] = []): string {
  return `${limitMessage(message, secrets)}. Bluesky still refused video uploads after a day of hourly checks; nothing was published.`;
}

function limitMessage(message: string | null | undefined, secrets: readonly string[]): string {
  const clean = sanitiseMessage(message, secrets).replace(/[.\s]+$/, "");
  return clean || DEFAULT_LIMIT_MESSAGE;
}

export const PROCESSING_CEILING_TEXT = "Bluesky did not finish processing the video within 30 minutes; nothing was published";
export const EXPIRED_TEXT = "Bluesky's upload expired before it finished; nothing was published";
export const lostUploadText = (code: string) => `Bluesky lost the upload before it finished (${code}); nothing was published.`;
export const partTimeoutText = (k: number, n: number) =>
  `Sending part ${k} of ${n} to Bluesky did not finish within the provider time limit (SCHEDULER_PROVIDER_TIMEOUT_SECONDS); will retry.`;
