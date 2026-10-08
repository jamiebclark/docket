import { z } from "zod";
import type { ActivityKind } from "./outcomes";

// Strict per-kind `details` shapes. No free-form keys: tokens, credentials and platform payloads have nowhere to go.

const url = z.string().max(2000);
const iso = z.iso.datetime({ offset: true });

export const ENGINE_REASONS = ["account_unavailable", "did_not_complete", "invalid_settings", "post_gone", "interrupted"] as const;
export const RESOLVE_ACTIONS = ["marked_published", "marked_not_published", "requeued", "retry_now", "retry_requeue", "retry_at", "bulk_retry"] as const;
export const CONNECT_FAIL_CODES = [
  "platform_error",
  "exchange_failed",
  "no_candidates",
  "too_many",
  "paste_refused",
  "paste_unreachable",
  "paste_none",
  "paste_too_many",
  "credentials_refused",
  "credentials_unreachable",
  "different_account",
] as const;

export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];
export type ConnectFailCode = (typeof CONNECT_FAIL_CODES)[number];

const schemas = {
  target_published: z.strictObject({ url: url.nullish(), backfilled: z.literal(true).optional() }),
  target_failed: z.strictObject({
    attempt: z.number().int().min(1).optional(),
    gaveUp: z.literal(true).optional(),
    engine: z.enum(ENGINE_REASONS).optional(),
    backfilled: z.literal(true).optional(),
  }),
  target_ambiguous: z.strictObject({ engine: z.literal("recovered_ambiguous").optional(), backfilled: z.literal(true).optional() }),
  target_retry_scheduled: z.strictObject({ attempt: z.number().int().min(1), nextAttemptAt: iso, interrupted: z.literal(true).optional() }),
  target_resolved: z.strictObject({
    action: z.enum(RESOLVE_ACTIONS),
    url: url.nullish(),
    scheduledAt: iso.optional(),
    mode: z.enum(["now", "requeue"]).optional(),
    requeue: z.literal("no_free_slot").optional(),
  }),
  account_needs_reauth: z.strictObject({
    reason: z.enum(["renewal_refused", "credentials_invalid"]),
    backfilled: z.literal(true).optional(),
  }),
  account_connect_failed: z.strictObject({ via: z.enum(["oauth", "paste", "credentials"]), code: z.enum(CONNECT_FAIL_CODES) }),
} satisfies Record<ActivityKind, z.ZodType>;

export type ActivityDetails<K extends ActivityKind = ActivityKind> = { [P in K]: z.infer<(typeof schemas)[P]> }[K];

export function activityDetailsSchema<K extends ActivityKind>(kind: K): (typeof schemas)[K] {
  return schemas[kind];
}
