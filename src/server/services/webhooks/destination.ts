import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { ZodError } from "zod";
import { isAllowedAddress } from "../../net/safe-fetch";

export const DESTINATION_REFUSED = "That address points at this server or a reserved network and can't receive webhooks.";
export const DESTINATION_UNRESOLVED = "We couldn't look up that host now; deliveries will check it each time.";
const LOOKUP_TIMEOUT_MS = 3000;

async function addressesOf(host: string): Promise<string[] | null> {
  if (isIP(host) !== 0) return [host];
  if (host === "localhost" || host.endsWith(".localhost")) return ["127.0.0.1"];
  try {
    const found = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS).unref?.()),
    ]);
    return found.map((a) => a.address);
  } catch {
    return null;
  }
}

/**
 * Save-time check of a webhook URL (FR-023): refuses a destination the `webhook` policy would refuse at delivery.
 * An unresolvable host is saved with a warning; delivery checks the address again every time.
 */
export async function checkWebhookDestination(url: string): Promise<{ warning: string | null }> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const addresses = await addressesOf(host);
  if (addresses === null) return { warning: DESTINATION_UNRESOLVED };
  if (addresses.some((a) => !isAllowedAddress(a, "webhook"))) {
    throw new ZodError([{ code: "custom", path: ["url"], message: DESTINATION_REFUSED, input: url }]);
  }
  return { warning: null };
}
