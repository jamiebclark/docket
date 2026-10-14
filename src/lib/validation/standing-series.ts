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

export const createStandingSeriesSchema = z.object({
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
  cadence: cadenceSchema,
  media: mediaSchema,
  approval: approvalPolicySchema.nullish(),
  scheduling: schedulingPolicySchema.nullish(),
  confirmUnreviewedQueue: z.boolean().default(false),
});
export type CreateStandingSeriesInput = z.infer<typeof createStandingSeriesSchema>;

export const updateStandingSeriesSchema = createStandingSeriesSchema;
export type UpdateStandingSeriesInput = z.infer<typeof updateStandingSeriesSchema>;

export const standingSeriesRunConfigSchema = z.object({
  v: z.literal(1),
  brief: z.string(),
  template: z.string(),
  templateFields: z.array(z.string()),
  voiceProfileId: z.uuid(),
  targetAccountIds: z.array(z.uuid()),
  cadence: cadenceSchema,
  media: mediaSchema,
  requested: z.object({ approval: approvalPolicySchema.nullable(), scheduling: schedulingPolicySchema.nullable() }),
  resolved: z.object({ approval: approvalPolicySchema, scheduling: schedulingPolicySchema }),
});
export type StandingSeriesRunConfig = z.infer<typeof standingSeriesRunConfigSchema>;
