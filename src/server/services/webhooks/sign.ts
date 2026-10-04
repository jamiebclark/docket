import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

function hmacHex(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** `v1=<hex>` per secret; two values during a rotation overlap (new first). */
export function signatureHeader(secrets: readonly string[], timestamp: number, rawBody: string): string {
  return secrets.map((s) => `v1=${hmacHex(s, timestamp, rawBody)}`).join(",");
}

export function verifySignature(input: {
  header: string;
  secret: string;
  timestamp: string;
  rawBody: string;
  now: number;
  toleranceSeconds?: number;
}): boolean {
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(input.now - ts) > (input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(hmacHex(input.secret, input.timestamp, input.rawBody), "utf8");
  let ok = false;
  for (const part of input.header.split(",")) {
    const [scheme, value] = part.trim().split("=");
    if (scheme !== "v1" || !value) continue;
    const given = Buffer.from(value, "utf8");
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}
