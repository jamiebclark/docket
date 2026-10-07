import { z } from "zod";
import type { ApiResolveTargetResult, ApiRetryTargetResult } from "@/lib/api/schemas";
import { ResolveTargetRequestSchema, ResolveTargetResultSchema, RetryTargetRequestSchema, RetryTargetResultSchema } from "@/lib/api/schemas";
import { resolveAmbiguous, retryTarget } from "../../services/posts";
import type { ResolveResult, RetryResult } from "../../services/posts";
import { toIssue, toWarning } from "./issues";
import { defineOperation } from "./types";

const targetParams = z.object({ postId: z.uuid(), targetId: z.uuid() });

function toRetryResult(postId: string, targetId: string, r: RetryResult): ApiRetryTargetResult {
  if (r.status === "scheduled") {
    return {
      postId,
      targetId,
      status: "scheduled",
      mode: r.mode,
      scheduledAt: r.scheduledAt,
      scheduledAtLocal: r.localTime,
      slotId: r.slotId,
      changedFromPreview: r.changedFromPreview,
      warnings: r.warnings.map(toWarning),
    };
  }
  return {
    postId,
    targetId,
    status: "failed",
    reason: r.reason,
    message: r.message,
    ...(r.issues ? { issues: r.issues.map(toIssue) } : {}),
  };
}

function toResolveResult(postId: string, targetId: string, r: ResolveResult): ApiResolveTargetResult {
  if (r.status === "published") return { postId, targetId, status: "published" };
  if (r.status === "scheduled") {
    return {
      postId,
      targetId,
      status: "scheduled",
      scheduledAt: r.scheduledAt,
      scheduledAtLocal: r.localTime,
      slotId: r.slotId,
      changedFromPreview: r.changedFromPreview,
    };
  }
  return { postId, targetId, status: "failed", reason: r.reason, message: r.message };
}

const ids = { postId: "0b6f6c2e-3a51-4f0e-9d6a-5d1f0a7c1a10", targetId: "7c1e2f43-9b0d-4a77-8e55-2a3d4c5b6e71" };
const errorExample = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details ? { details } : {}), requestId: "req_example" },
});

export const targetOperations = [
  defineOperation({
    id: "retryPostTarget",
    method: "POST",
    path: "/posts/{postId}/targets/{targetId}/retry",
    permission: "write_posts",
    tag: "Recovery",
    summary: "Retry a failed target",
    description:
      "Retries one failed target. `now` publishes on the next tick, `requeue` takes the next free slot of the account (pass `expected` to learn whether the instant moved), and `at` schedules an RFC 3339 instant with an offset. A refusal is reported in a 200 response with `status: failed`.",
    params: targetParams,
    body: {
      kind: "json",
      schema: RetryTargetRequestSchema,
      examples: {
        now: { summary: "Publish on the next tick", value: { mode: "now" } },
        requeue: { summary: "Take the next free slot", value: { mode: "requeue", expected: "2026-10-08T09:00:00+02:00" } },
        at: { summary: "Schedule an instant", value: { mode: "at", at: "2026-10-08T15:30:00+02:00" } },
      },
    },
    resourceParams: ["postId", "targetId"],
    responses: {
      200: {
        description: "The target was rescheduled, or the reason it was not (`status: failed` with a `reason`)",
        schema: RetryTargetResultSchema,
        examples: {
          scheduled: {
            summary: "Rescheduled into the next free slot",
            value: {
              ...ids,
              status: "scheduled",
              mode: "requeue",
              scheduledAt: "2026-10-08T07:00:00.000Z",
              scheduledAtLocal: "Thu 8 Oct, 09:00",
              slotId: "3f0c1d52-6a8e-4b19-b7c4-9e2d1a0f8c33",
              changedFromPreview: false,
              warnings: [],
            },
          },
          no_free_occurrence: {
            summary: "No free posting slot",
            value: {
              ...ids,
              status: "failed",
              reason: "no_free_occurrence",
              message: "Not retried — Acme Bluesky has no free posting slot. Retry now or pick a time.",
            },
          },
          in_past: {
            summary: "The requested time has passed",
            value: { ...ids, status: "failed", reason: "in_past", message: "That time has passed. Use Retry now instead." },
          },
          validation: {
            summary: "The content no longer validates",
            value: {
              ...ids,
              status: "failed",
              reason: "validation",
              message: "The post no longer passes validation.",
              issues: [{ severity: "error", code: "text_too_long", message: "Text is too long.", field: "text" }],
            },
          },
        },
      },
      400: {
        description: "Invalid request body",
        examples: { invalid: { summary: "Missing mode", value: errorExample("validation_failed", "Invalid request.") } },
      },
      401: { description: "Missing or invalid API key", examples: { invalid: { summary: "Bad key", value: errorExample("invalid_api_key", "Invalid API key.") } } },
      403: { description: "The key lacks `write_posts`", examples: { missing: { summary: "Read-only key", value: errorExample("missing_permission", "This key lacks the write_posts permission.") } } },
      404: {
        description: "No such target on that post (an unknown id, a mismatched pairing and a deleted post look the same)",
        examples: { not_found: { summary: "Not found", value: errorExample("not_found", "Not found.") } },
      },
      409: {
        description:
          "The target cannot be retried. `details.reason` is one of `publishing`, `not_failed` (also for ambiguous, scheduled, published and cancelled targets), `account_removed`, `needs_reconnecting`, `provider_unavailable`. Nothing is written.",
        examples: {
          not_failed: { summary: "Already retried", value: errorExample("conflict", "This post is no longer failed.", { reason: "not_failed" }) },
          needs_reconnecting: {
            summary: "Account needs reconnecting",
            value: errorExample("conflict", "Acme Bluesky needs to be reconnected before this post can be retried.", { reason: "needs_reconnecting" }),
          },
        },
      },
      422: {
        description: "The Idempotency-Key was reused with a different request",
        examples: { mismatch: { summary: "Key reuse", value: errorExample("idempotency_key_reused", "This Idempotency-Key was used with a different request.") } },
      },
      429: { description: "Rate limited", examples: { limited: { summary: "Slow down", value: errorExample("rate_limited", "Too many requests.") } } },
    },
    idempotent: true,
    async run(scope, { params, body }) {
      const r = await retryTarget(scope, params.targetId, body, { postId: params.postId });
      return { status: 200, body: toRetryResult(params.postId, params.targetId, r) };
    },
  }),
  defineOperation({
    id: "resolvePostTarget",
    method: "POST",
    path: "/posts/{postId}/targets/{targetId}/resolve",
    permission: "write_posts",
    tag: "Recovery",
    summary: "Resolve an ambiguous publish",
    description:
      "Records what happened to a target whose publish outcome is unknown (`ambiguous`): it was `published` (optionally with its `url`), or `not_published` and either left failed (`requeue: false`) or requeued into the next free slot (`requeue: true`, with `expected` to learn whether the instant moved). A requeue that finds no free slot is reported in a 200 response with `status: failed`.",
    params: targetParams,
    body: {
      kind: "json",
      schema: ResolveTargetRequestSchema,
      examples: {
        published: { summary: "It was published", value: { outcome: "published", url: "https://bsky.app/profile/acme/post/3k4abc" } },
        not_published: { summary: "Not published, leave it failed", value: { outcome: "not_published", requeue: false } },
        requeue: {
          summary: "Not published, requeue it",
          value: { outcome: "not_published", requeue: true, expected: "2026-10-08T09:00:00+02:00" },
        },
      },
    },
    resourceParams: ["postId", "targetId"],
    responses: {
      200: {
        description: "The resolution that was recorded",
        schema: ResolveTargetResultSchema,
        examples: {
          published: { summary: "Marked published", value: { ...ids, status: "published" } },
          scheduled: {
            summary: "Requeued into the next free slot",
            value: {
              ...ids,
              status: "scheduled",
              scheduledAt: "2026-10-08T07:00:00.000Z",
              scheduledAtLocal: "Thu 8 Oct, 09:00",
              slotId: "3f0c1d52-6a8e-4b19-b7c4-9e2d1a0f8c33",
              changedFromPreview: false,
            },
          },
          not_requeued: {
            summary: "Marked not published and left failed",
            value: { ...ids, status: "failed", reason: "not_requeued", message: "Marked not published by a team member. Retry or schedule it." },
          },
          no_free_slot: {
            summary: "Requeue found no free slot",
            value: { ...ids, status: "failed", reason: "no_free_slot", message: "Not published — no free posting slot. Retry or schedule it." },
          },
        },
      },
      400: {
        description: "Invalid request body (an unknown `outcome`, or a `url` that is not a valid link)",
        examples: { invalid: { summary: "Bad url", value: errorExample("validation_failed", "Invalid request.") } },
      },
      401: { description: "Missing or invalid API key", examples: { invalid: { summary: "Bad key", value: errorExample("invalid_api_key", "Invalid API key.") } } },
      403: { description: "The key lacks `write_posts`", examples: { missing: { summary: "Read-only key", value: errorExample("missing_permission", "This key lacks the write_posts permission.") } } },
      404: {
        description: "No such target on that post (an unknown id, a mismatched pairing and a deleted post look the same)",
        examples: { not_found: { summary: "Not found", value: errorExample("not_found", "Not found.") } },
      },
      409: {
        description:
          "The target cannot be resolved. `details.reason` is `already_resolved` (the target is not ambiguous) or `cannot_publish` (a requeue was refused because the account cannot publish). Nothing is written.",
        examples: {
          already_resolved: {
            summary: "Already resolved",
            value: errorExample("conflict", "This post was already resolved.", { reason: "already_resolved" }),
          },
          cannot_publish: {
            summary: "Account cannot publish",
            value: errorExample("conflict", "Acme Bluesky needs to be reconnected before this post can be published.", { reason: "cannot_publish" }),
          },
        },
      },
      422: {
        description: "The Idempotency-Key was reused with a different request",
        examples: { mismatch: { summary: "Key reuse", value: errorExample("idempotency_key_reused", "This Idempotency-Key was used with a different request.") } },
      },
      429: { description: "Rate limited", examples: { limited: { summary: "Slow down", value: errorExample("rate_limited", "Too many requests.") } } },
    },
    idempotent: true,
    async run(scope, { params, body }) {
      // The service compares instants and accepts UTC only; the API accepts any RFC 3339 offset.
      const input = body.outcome === "not_published" && body.requeue && body.expected ? { ...body, expected: new Date(body.expected).toISOString() } : body;
      const r = await resolveAmbiguous(scope, params.targetId, input, { postId: params.postId });
      return { status: 200, body: toResolveResult(params.postId, params.targetId, r) };
    },
  }),
];
