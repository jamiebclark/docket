import { z } from "zod";
import { CADENCE_COUNT_MAX, CADENCE_COUNT_MIN, CADENCE_PERIODS } from "../series/cadence";
import { BRIEF_MAX, INSTRUCTIONS_MAX, TARGET_ACCOUNTS_MAX } from "./generation";
import { IMAGE_PROMPT_MAX } from "../../server/llm/image-generation";
import { tagSchema } from "./media";
import { approvalPolicySchema, schedulingPolicySchema } from "./policies";

export const STANDING_SERIES_NAME_MAX = 100;

const cadenceSchema = z.object({
  count: z
    .number()
    .int()
    .min(CADENCE_COUNT_MIN, { error: `Choose between ${CADENCE_COUNT_MIN} and ${CADENCE_COUNT_MAX} posts` })
    .max(CADENCE_COUNT_MAX, { error: `Choose between ${CADENCE_COUNT_MIN} and ${CADENCE_COUNT_MAX} posts` }),
  period: z.enum(CADENCE_PERIODS, { error: "Choose a cadence period" }),
});

const mediaSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("none") }),
  z.object({ source: z.literal("pool"), tag: tagSchema.nullish() }),
  z.object({
    source: z.literal("generate"),
    prompt: z
      .string()
      .trim()
      .min(1, { error: "Enter a prompt" })
      .max(IMAGE_PROMPT_MAX, { error: `At most ${IMAGE_PROMPT_MAX} characters` }),
  }),
]);
export type StandingSeriesMediaInput = z.infer<typeof mediaSchema>;

export const OCCURRENCE_RULES = ["cadence", "dated_list"] as const;
export type OccurrenceRule = (typeof OCCURRENCE_RULES)[number];

export const createStandingSeriesSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: "Give the series a name" })
      .max(STANDING_SERIES_NAME_MAX, { error: `A name can be at most ${STANDING_SERIES_NAME_MAX} characters` }),
    brief: z.string().trim().min(1, { error: "Describe what the series is about" }).max(BRIEF_MAX),
    template: z
      .string()
      .trim()
      .min(1, { error: "Write the instructions for each post" })
      .max(INSTRUCTIONS_MAX, { error: `Instructions are at most ${INSTRUCTIONS_MAX} characters` }),
    voiceProfileId: z.uuid({ error: "Choose a voice profile" }),
    targetAccountIds: z
      .array(z.uuid())
      .min(1, { error: "Choose at least one account" })
      .max(TARGET_ACCOUNTS_MAX)
      .refine((ids) => new Set(ids).size === ids.length, { error: "Each account can be chosen once" }),
    occurrenceRule: z.enum(OCCURRENCE_RULES).default("cadence"),
    cadence: cadenceSchema.nullish(),
    leadDays: z.number().int().min(0).max(30).default(0),
    media: mediaSchema,
    approval: approvalPolicySchema.nullish(),
    scheduling: schedulingPolicySchema.nullish(),
    confirmUnreviewedQueue: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.occurrenceRule === "cadence" && !val.cadence) {
      ctx.addIssue({ code: "custom", message: "Choose how often it posts", path: ["cadence"] });
    }
    if (val.occurrenceRule === "dated_list" && val.cadence) {
      ctx.addIssue({ code: "custom", message: "A dated series has no cadence", path: ["cadence"] });
    }
    if (val.occurrenceRule === "cadence" && val.leadDays !== 0) {
      ctx.addIssue({ code: "custom", message: "Lead time only applies to a dated list", path: ["leadDays"] });
    }
  });
export type CreateStandingSeriesInput = z.infer<typeof createStandingSeriesSchema>;

export const updateStandingSeriesSchema = createStandingSeriesSchema;
export type UpdateStandingSeriesInput = z.infer<typeof updateStandingSeriesSchema>;

export const standingSeriesRunConfigSchema = z.object({
  v: z.literal(1),
  rule: z.enum(OCCURRENCE_RULES).default("cadence"),
  brief: z.string(),
  template: z.string(),
  templateFields: z.array(z.string()),
  voiceProfileId: z.uuid(),
  targetAccountIds: z.array(z.uuid()),
  cadence: cadenceSchema.nullable(),
  leadDays: z.number().int().min(0).max(30).default(0),
  media: mediaSchema,
  requested: z.object({ approval: approvalPolicySchema.nullable(), scheduling: schedulingPolicySchema.nullable() }),
  resolved: z.object({ approval: approvalPolicySchema, scheduling: schedulingPolicySchema }),
});
export type StandingSeriesRunConfig = z.infer<typeof standingSeriesRunConfigSchema>;

/** `standing_series_positions.dated`: the position's whole dated payload (data-model.md §5). */
export const datedPositionSchema = z.object({
  v: z.literal(1),
  rowId: z.string(),
  year: z.number().int(),
  targetDate: z.string(),
  keyValue: z.string(),
  values: z.record(z.string(), z.string()),
  mediaAssetId: z.string().nullable(),
  mediaFilename: z.string().nullable(),
});
export type DatedPosition = z.infer<typeof datedPositionSchema>;
