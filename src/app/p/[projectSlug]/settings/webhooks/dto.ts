import type { EndpointView } from "@/server/services/webhooks";

/** An endpoint as the client sees it. There is no secret and no ciphertext. */
export interface EndpointDto {
  id: string;
  url: string;
  host: string;
  description: string;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  secretRotating: boolean;
  oldSecretUntil: string | null;
  lastDelivery: { status: string; at: string; statusCode: number | null } | null;
}

export const EVENT_LABELS: Record<string, string> = {
  "post.published": "Post published",
  "post.failed": "Post failed",
  "job.finished": "Job finished",
  "account.needs_reauth": "Account needs reconnecting",
  ping: "Test event",
};

export function toEndpointDto(e: EndpointView): EndpointDto {
  return {
    id: e.id,
    url: e.url,
    host: new URL(e.url).host,
    description: e.description,
    events: e.events,
    enabled: e.enabled,
    disabledReason: e.disabledReason,
    secretRotating: e.secretRotating,
    oldSecretUntil: e.oldSecretUntil?.toISOString() ?? null,
    lastDelivery: e.lastDelivery
      ? { status: e.lastDelivery.status, at: e.lastDelivery.at.toISOString(), statusCode: e.lastDelivery.statusCode }
      : null,
  };
}
