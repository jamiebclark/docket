import { z } from "zod";

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
