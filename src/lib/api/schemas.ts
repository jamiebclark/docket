import { z } from "zod";
import { ACTIVITY_KINDS, ACTIVITY_OUTCOMES } from "@/lib/activity/outcomes";
import { pageQuerySchema } from "@/lib/validation/api";
import { atSchema, externalUrlSchema } from "@/lib/validation/scheduling";

// Output shapes of the public API (contracts/http-api.md). Each carries `.meta({ id })` so the OpenAPI
// document registers it as a component. The presenters in `src/server/services/views/` build these.

const iso = z.string().meta({ description: "RFC 3339 instant in UTC", example: "2026-10-04T10:00:00.000Z" });
const isoOrNull = iso.nullable();

export const AccountSchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    displayName: z.string(),
    status: z.enum(["active", "needs_reauth"]),
    lastError: z.string().nullable(),
    postingInstructions: z
      .string()
      .nullable()
      .meta({ description: "Free-text guidance on how to write for this account; null when none is set." }),
    capabilities: z.object({
      textLimit: z.number().int(),
      countingRule: z.string(),
      media: z.object({
        required: z.boolean(),
        maxImages: z.number().int(),
        mimeTypes: z.array(z.string()),
      }),
      postTypes: z.array(z.string()),
    }),
  })
  .meta({ id: "Account" });

export const MediaSchema = z
  .object({
    id: z.uuid(),
    url: z.string(),
    thumbnailUrl: z.string().nullable(),
    mimeType: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    byteSize: z.number().int(),
    altText: z.string(),
    tags: z.array(z.string()),
    used: z.boolean(),
    reservedByJobId: z.uuid().nullable(),
    kind: z.enum(["image", "video"]),
    processingState: z.enum(["processing", "ready", "failed"]),
    processingError: z.string().nullable(),
    video: z
      .object({
        durationSeconds: z.number(),
        frameRate: z.number().nullable(),
        videoCodec: z.string(),
        audioCodec: z.string().nullable(),
        container: z.enum(["mp4", "mov"]),
      })
      .nullable(),
    createdAt: iso,
  })
  .meta({ id: "Media" });

export const TargetSchema = z
  .object({
    id: z.uuid(),
    accountId: z.uuid(),
    accountName: z.string(),
    provider: z.string(),
    status: z.string(),
    scheduleKind: z.enum(["slot", "explicit", "now"]).nullable(),
    scheduledAt: isoOrNull,
    scheduledAtLocal: z.string().nullable(),
    externalId: z.string().nullable(),
    externalUrl: z.string().nullable(),
    attemptCount: z.number().int(),
    lastError: z.string().nullable(),
    overrideText: z.string().nullable(),
    /** The effective post type: the chosen one, else the provider's default for this content. */
    postType: z.string().nullable(),
  })
  .meta({ id: "Target" });

export const CreatedBySchema = z.object({ type: z.enum(["user", "api_key"]), name: z.string() });

export const PostSchema = z
  .object({
    id: z.uuid(),
    status: z.string(),
    reviewState: z.string(),
    origin: z.enum(["manual", "generated", "api"]),
    text: z.string(),
    media: z.array(z.object({ id: z.uuid(), url: z.string().nullable(), altText: z.string() })),
    generation: z
      .object({ brief: z.string(), voiceProfileId: z.string(), decision: z.string().nullable() })
      .nullable(),
    createdBy: CreatedBySchema.nullable(),
    createdAt: iso,
    updatedAt: iso,
    targets: z.array(TargetSchema),
  })
  .meta({ id: "Post" });

const IssueSchema = z.object({
  severity: z.string().optional(),
  code: z.string(),
  message: z.string(),
  field: z.string().optional(),
});

export const TargetValidationSchema = z
  .object({ targetId: z.uuid(), accountId: z.uuid(), ok: z.boolean(), issues: z.array(IssueSchema) })
  .meta({ id: "TargetValidation" });

export const TargetResultSchema = z
  .union([
    z.object({
      targetId: z.uuid(),
      accountId: z.uuid(),
      ok: z.literal(true),
      scheduledAt: iso,
      scheduledAtLocal: z.string(),
      warnings: z.array(IssueSchema).optional(),
    }),
    z.object({
      targetId: z.uuid(),
      accountId: z.uuid(),
      ok: z.literal(false),
      code: z.string(),
      message: z.string(),
      issues: z.array(IssueSchema).optional(),
    }),
  ])
  .meta({ id: "TargetResult" });

export const OccurrenceSchema = z
  .object({
    accountId: z.uuid(),
    slotId: z.uuid(),
    scheduledAt: iso,
    scheduledAtLocal: z.string(),
    free: z.boolean(),
    postId: z.uuid().nullable(),
    targetId: z.uuid().nullable(),
  })
  .meta({ id: "Occurrence" });

const JobCountsSchema = z.object({
  queued: z.number().int(),
  running: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
});

const jobSummaryShape = {
  id: z.uuid(),
  status: z.string(),
  open: z.boolean(),
  sourceKind: z.string(),
  sourceSummary: z.string(),
  itemCount: z.number().int(),
  counts: JobCountsSchema,
  approvalPolicy: z.string(),
  schedulingPolicy: z.string(),
  createdBy: CreatedBySchema.nullable(),
  createdAt: iso,
  startedAt: isoOrNull,
  finishedAt: isoOrNull,
  cancelledAt: isoOrNull,
};

export const JobSummarySchema = z.object(jobSummaryShape).meta({ id: "JobSummary" });

export const JobSchema = z
  .object({
    ...jobSummaryShape,
    fields: z.array(z.string()),
    template: z.string(),
    accountIds: z.array(z.uuid()),
    voiceProfileId: z.uuid(),
  })
  .meta({ id: "Job" });

export const JobItemSchema = z
  .object({
    id: z.uuid(),
    position: z.number().int(),
    label: z.string(),
    status: z.string(),
    attempts: z.number().int(),
    mediaId: z.uuid().nullable(),
    post: z.object({ id: z.uuid(), reviewState: z.string() }).nullable(),
    error: z.object({ kind: z.string(), message: z.string() }).nullable(),
    finishedAt: isoOrNull,
  })
  .meta({ id: "JobItem" });

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "Error" });

export type ApiAccount = z.infer<typeof AccountSchema>;
export type ApiMedia = z.infer<typeof MediaSchema>;
export type ApiTarget = z.infer<typeof TargetSchema>;
export type ApiPost = z.infer<typeof PostSchema>;
export type ApiJobSummary = z.infer<typeof JobSummarySchema>;
export type ApiJob = z.infer<typeof JobSchema>;
export type ApiJobItem = z.infer<typeof JobItemSchema>;

// ---------------------------------------------------------------- retry, resolve, bulk retry (016)

const rfc3339 = z.iso.datetime({ offset: true, error: "Enter a valid RFC 3339 date and time with an offset" });

export const RetryTargetRequestSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("now") }),
    z.strictObject({ mode: z.literal("requeue"), expected: rfc3339.optional() }),
    z.strictObject({ mode: z.literal("at"), at: atSchema }),
  ])
  .meta({ id: "RetryTargetRequest" });

const retryFailureReason = z.enum(["no_active_slots", "no_free_occurrence", "in_past", "validation", "account_unavailable"]);

export const RetryTargetResultSchema = z
  .union([
    z.object({
      postId: z.uuid(),
      targetId: z.uuid(),
      status: z.literal("scheduled"),
      mode: z.enum(["now", "requeue", "at"]),
      scheduledAt: iso,
      scheduledAtLocal: z.string(),
      slotId: z.uuid().nullable(),
      changedFromPreview: z.boolean(),
      warnings: z.array(IssueSchema),
    }),
    z.object({
      postId: z.uuid(),
      targetId: z.uuid(),
      status: z.literal("failed"),
      reason: retryFailureReason,
      message: z.string(),
      issues: z.array(IssueSchema).optional(),
    }),
  ])
  .meta({ id: "RetryTargetResult" });

export const ResolveTargetRequestSchema = z
  .union([
    z.strictObject({ outcome: z.literal("published"), url: externalUrlSchema.optional() }),
    z.strictObject({ outcome: z.literal("not_published"), requeue: z.literal(true), expected: rfc3339.optional() }),
    z.strictObject({ outcome: z.literal("not_published"), requeue: z.literal(false) }),
  ])
  .meta({ id: "ResolveTargetRequest" });

export const ResolveTargetResultSchema = z
  .union([
    z.object({ postId: z.uuid(), targetId: z.uuid(), status: z.literal("published") }),
    z.object({
      postId: z.uuid(),
      targetId: z.uuid(),
      status: z.literal("scheduled"),
      scheduledAt: iso,
      scheduledAtLocal: z.string(),
      slotId: z.uuid(),
      changedFromPreview: z.boolean(),
    }),
    z.object({
      postId: z.uuid(),
      targetId: z.uuid(),
      status: z.literal("failed"),
      reason: z.enum(["not_requeued", "no_free_slot"]),
      message: z.string(),
    }),
  ])
  .meta({ id: "ResolveTargetResult" });

export const RetryFailedTargetsRequestSchema = z
  .strictObject({ accountId: z.uuid().optional(), mode: z.enum(["now", "requeue"]) })
  .meta({ id: "RetryFailedTargetsRequest" });

const skippedCounts = z.object({
  account_removed: z.number().int(),
  needs_reconnecting: z.number().int(),
  provider_unavailable: z.number().int(),
  no_longer_failed: z.number().int(),
  cannot_publish: z.number().int(),
  no_free_slot: z.number().int(),
});

export const RetryFailedTargetsResultSchema = z
  .object({
    mode: z.enum(["now", "requeue"]),
    retried: z.number().int(),
    inScope: z.number().int(),
    skipped: skippedCounts,
    remaining: z.number().int(),
    accounts: z.array(
      z.object({
        accountId: z.uuid(),
        name: z.string(),
        retried: z.number().int(),
        skipped: skippedCounts,
        remaining: z.number().int(),
      }),
    ),
    message: z.string(),
  })
  .meta({ id: "RetryFailedTargetsResult" });

export type ApiRetryTargetResult = z.infer<typeof RetryTargetResultSchema>;
export type ApiResolveTargetResult = z.infer<typeof ResolveTargetResultSchema>;
export type ApiRetryFailedTargetsResult = z.infer<typeof RetryFailedTargetsResultSchema>;

export const ApiActivityEventSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(ACTIVITY_KINDS),
    outcome: z.enum(ACTIVITY_OUTCOMES),
    occurredAt: iso,
    occurredAtLocal: z.string().meta({
      description: "The same instant in the project time zone, as an RFC 9557 string with the zone name.",
      example: "2026-10-06T09:02:11.512-04:00[America/New_York]",
    }),
    platform: z.string().nullable().meta({ description: "The provider key; null for a connect failure that spans several platforms." }),
    platforms: z.array(z.string()),
    account: z.object({ id: z.uuid(), name: z.string(), removed: z.boolean() }).nullable(),
    post: z.object({ id: z.uuid(), targetId: z.uuid(), excerpt: z.string(), deleted: z.boolean() }).nullable(),
    message: z.string(),
    actor: z.object({
      type: z.enum(["scheduler", "member", "api_key"]),
      name: z.string().meta({ description: '"Scheduler", the member name, "Former member", "API key {name}" or "Removed API key".' }),
    }),
    details: z.record(z.string(), z.unknown()).meta({ description: "Per-kind keys only. Never a secret or post content." }),
  })
  .meta({ id: "ApiActivityEvent" });

export const ApiActivityPageSchema = z
  .object({ data: z.array(ApiActivityEventSchema), nextCursor: z.string().nullable() })
  .meta({ id: "ApiActivityPage" });

const activityParam = (description: string, example?: string) =>
  z.union([z.string(), z.array(z.string())]).optional().meta({ description, ...(example ? { example } : {}) });

/** Strict: an unknown parameter is a 400. Values are checked by `listActivityForApi`, which reports each bad field. */
export const ApiActivityQuerySchema = z.strictObject({
  outcome: activityParam(
    "An outcome (published, failed, ambiguous, retrying, resolved, needs_reauth, connect_failed) or a preset (successes, problems). Repeat or comma-separate to combine.",
    "problems",
  ),
  platform: activityParam("A platform key such as instagram. Group connect failures match each of their platforms.", "instagram"),
  account: activityParam("A connected account id. Another project's account matches nothing."),
  from: activityParam("First day, YYYY-MM-DD, in the project time zone. Inclusive.", "2026-10-01"),
  to: activityParam("Last day, YYYY-MM-DD, in the project time zone. Inclusive.", "2026-10-07"),
  range: activityParam("today, 7d or 30d, counted in the project time zone and including today. Overrides from and to.", "7d"),
  ...pageQuerySchema.shape,
});
export type ApiActivityQuery = z.infer<typeof ApiActivityQuerySchema>;
export type ApiActivityPage = z.infer<typeof ApiActivityPageSchema>;
