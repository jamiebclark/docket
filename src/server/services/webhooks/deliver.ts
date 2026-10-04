import type { AttemptErrorKind, AttemptOutcome, DeliveryRecord, EndpointRecord, EventRecord } from "../../dal/webhooks";
import { UrlFetchError } from "../../dal/errors";
import { postGuarded } from "../../net/safe-fetch";
import { redact } from "../../scheduler/redact";
import { activeSecrets } from "./endpoints";
import { signatureHeader } from "./sign";

const EXCERPT_CHARS = 1000;

function classify(error: unknown): AttemptErrorKind {
  const e = error as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = e?.cause?.code ?? e?.code ?? "";
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (/CERT|TLS|SSL|ERR_SSL/i.test(code)) return "tls";
  if (code) return "connect";
  return "connect";
}

function excerptOf(text: string, secrets: readonly string[]): string | null {
  return text ? redact(text.slice(0, EXCERPT_CHARS), secrets) : null;
}

/**
 * One HTTP attempt. Redirects are not followed (a 3xx is a failure), and the body is the exact JSON the
 * signature covers. Never throws: every outcome is an `AttemptOutcome`.
 */
export async function sendDelivery(input: {
  endpoint: EndpointRecord;
  event: EventRecord;
  delivery: DeliveryRecord;
  now: Date;
  timeoutMs: number;
}): Promise<AttemptOutcome> {
  const { endpoint, event, now } = input;
  const started = Date.now();
  const secrets = activeSecrets(endpoint, now);
  const rawBody = JSON.stringify(event.body);
  const timestamp = Math.floor(now.getTime() / 1000);
  try {
    const res = await postGuarded(endpoint.url, {
      policy: "webhook",
      timeoutMs: input.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Docket-Webhooks/1",
        "Docket-Event-Id": event.id,
        "Docket-Event-Type": event.type,
        "Docket-Timestamp": String(timestamp),
        "Docket-Signature": signatureHeader(secrets, timestamp, rawBody),
      },
      body: rawBody,
    });
    const excerpt = excerptOf(res.excerpt, secrets);
    const ok = res.status >= 200 && res.status < 300;
    return {
      statusCode: res.status,
      errorKind: ok ? null : res.status >= 300 && res.status < 400 ? "redirect" : "http_status",
      durationMs: Date.now() - started,
      responseExcerpt: excerpt,
      ok,
      gone: res.status === 410,
    };
  } catch (error) {
    return {
      statusCode: null,
      errorKind: error instanceof UrlFetchError && error.code === "url_not_allowed" ? "address_not_allowed" : classify(error),
      durationMs: Date.now() - started,
      responseExcerpt: null,
      ok: false,
      gone: false,
    };
  }
}
