import { z } from "zod";
import { INSTRUCTIONS_MAX, TARGET_ACCOUNTS_MAX } from "./generation";
import { tagSchema } from "./media";
import { approvalPolicySchema, schedulingPolicySchema } from "./policies";

export const JOB_ITEMS_MAX = 500;
export const JOB_TEMPLATE_MAX = INSTRUCTIONS_MAX;
export const JOB_ITEM_DATA_MAX = 50_000;
export const JOB_SOURCE_KIND_MAX = 32;

export const mediaSelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("pick"),
    ids: z
      .array(z.uuid())
      .min(1, { error: "Choose at least one image" })
      .max(JOB_ITEMS_MAX, { error: `A job can hold at most ${JOB_ITEMS_MAX} images` }),
  }),
  z.object({
    mode: z.literal("filter"),
    filter: z.object({
      tag: tagSchema.optional(),
      missingAlt: z.boolean().optional(),
      q: z.string().trim().max(100).optional(),
    }),
  }),
  z.object({ mode: z.literal("unused") }),
]);
export type MediaSelection = z.infer<typeof mediaSelectionSchema>;

export const jobSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("media"), selection: mediaSelectionSchema, includeUsed: z.boolean() }),
  z.object({ kind: z.literal("csv") }),
  // Validated in full by the api source (`apiSourceInputSchema` in ./api); kept loose here so the modules do not import each other.
  z.looseObject({ kind: z.literal("api") }),
]);
export type JobSourceInput = z.infer<typeof jobSourceSchema>;

export const createJobSchema = z.object({
  source: jobSourceSchema,
  voiceProfileId: z.uuid({ error: "Choose a voice profile" }),
  template: z
    .string()
    .trim()
    .min(1, { error: "Write the instructions for each post" })
    .max(JOB_TEMPLATE_MAX, { error: `Instructions are at most ${JOB_TEMPLATE_MAX} characters` }),
  targetAccountIds: z
    .array(z.uuid())
    .min(1, { error: "Choose at least one account" })
    .max(TARGET_ACCOUNTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Each account can be chosen once" }),
  approval: approvalPolicySchema.nullish(),
  scheduling: schedulingPolicySchema.nullish(),
  confirmUnreviewedQueue: z.boolean().default(false),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

/** `generation_job_items.payload`: the template fields of one item. */
export const itemPayloadSchema = z.object({
  v: z.literal(1),
  fields: z.record(z.string(), z.string()),
});
export type ItemPayload = z.infer<typeof itemPayloadSchema>;
