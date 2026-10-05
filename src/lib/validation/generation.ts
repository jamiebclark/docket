import { z } from "zod";
import { approvalPolicySchema, schedulingPolicySchema } from "./policies";
import { POST_MEDIA_MAX } from "./scheduling";

export const BRIEF_MAX = 2000;
export const SOURCE_TEXT_MAX = 50_000;
export const INSTRUCTIONS_MAX = 2000;
/** Rendered job instructions (a 2,000-character template plus values) can be longer than a form field allows. */
export const JOB_INSTRUCTIONS_MAX = 10_000;
export const TARGET_ACCOUNTS_MAX = 50;

const angleSchema = z.object({ title: z.string().min(1).max(120), description: z.string().min(1).max(300) });

export const generationInputsSchema = z.object({
  brief: z.string().trim().min(1, { error: "Describe what the post is about" }).max(BRIEF_MAX),
  sourceText: z.string().max(SOURCE_TEXT_MAX).nullable(),
  instructions: z.string().max(JOB_INSTRUCTIONS_MAX).nullable(),
  itemFields: z.record(z.string(), z.string()).nullish(),
  mediaAssetIds: z.array(z.uuid()).max(POST_MEDIA_MAX),
  targetAccountIds: z
    .array(z.uuid())
    .min(1, { error: "Choose at least one account" })
    .max(TARGET_ACCOUNTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Each account can be chosen once" }),
  series: z
    .object({
      id: z.uuid(),
      position: z.number().int().min(0),
      angle: angleSchema,
      otherAngles: z.array(z.string()),
    })
    .nullable(),
});
export type GenerationInputs = z.infer<typeof generationInputsSchema>;

const failureKind = z.enum([
  "invalid_output",
  "refused",
  "incomplete",
  "timeout",
  "rate_limited",
  "unavailable",
  "auth",
  "bad_request",
]);
const usage = z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() });

export const generationRecordSchema = z.object({
  at: z.string(),
  mode: z.enum(["single", "series_post", "regenerate", "job_item"]),
  job: z
    .object({ id: z.string(), itemId: z.string(), position: z.number().int().min(0), sourceKind: z.string() })
    .nullish(),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string(),
  voiceProfile: z.object({ id: z.string(), versionId: z.string(), version: z.number().int(), name: z.string() }),
  inputs: generationInputsSchema,
  prompt: z.object({
    system: z.string(),
    user: z.string(),
    images: z.array(z.object({ mediaAssetId: z.string(), mode: z.enum(["url", "bytes"]) })),
  }),
  policies: z.object({
    requested: z.object({ approval: approvalPolicySchema.nullable(), scheduling: schedulingPolicySchema.nullable() }),
    resolved: z.object({ approval: approvalPolicySchema, scheduling: schedulingPolicySchema }),
    decision: z
      .object({
        reviewState: z.enum(["needs_review", "approved"]),
        queued: z.boolean(),
        reason: z.string(),
      })
      .nullable(),
  }),
  attempts: z.array(z.object({ kind: z.union([z.literal("ok"), z.literal("invalid_platform"), failureKind]), latencyMs: z.number(), usage })),
  retried: z
    .object({
      reason: z.enum(["invalid_output", "invalid_platform", "refused", "incomplete", "timeout"]),
      problems: z.array(z.string()),
    })
    .nullable(),
  output: z.object({ variants: z.record(z.string(), z.string()), imageAltTexts: z.array(z.string()).nullable() }),
  remainingProblems: z.array(
    z.object({ providerKey: z.string(), groupKey: z.string().nullish(), label: z.string().nullish(), messages: z.array(z.string()) }),
  ),
  /** The accounts and posting instructions this request used; absent on records written before posting instructions. */
  accounts: z
    .array(
      z.object({
        accountId: z.string(),
        displayName: z.string(),
        providerKey: z.string(),
        instructions: z.string().nullable(),
        groupKey: z.string(),
      }),
    )
    .nullish(),
});
export type GenerationRecord = z.infer<typeof generationRecordSchema>;

export const generationMetadataSchema = z.object({
  v: z.literal(1),
  records: z.array(generationRecordSchema),
});
export type GenerationMetadata = z.infer<typeof generationMetadataSchema>;

export { approvalPolicySchema, schedulingPolicySchema };
