import { z } from "zod";
import { JOB_ITEM_DATA_MAX } from "./jobs";

export const DATED_KEY_VALUE_MAX = 500;
export const IMPORT_PROBLEMS_MAX = 100;

/** One row as a person types it in the row dialog. */
export const datedRowInputSchema = z.object({
  date: z.string().trim().min(1, { error: "Enter a date as MM-DD or YYYY-MM-DD" }),
  media: z.string().trim().max(255).nullish(),
  /** Every non-reserved column of the list → its value. Extra or missing keys are refused. */
  fields: z.record(z.string(), z.string().max(JOB_ITEM_DATA_MAX)),
});
export type DatedRowInput = z.infer<typeof datedRowInputSchema>;

export const importDatedListSchema = z.object({ filename: z.string().trim().min(1).max(255) });
export type ImportDatedListInput = z.infer<typeof importDatedListSchema>;

export const importProblemSchema = z.object({ line: z.number().int().nullable(), message: z.string().max(300) });
export const importRecordSchema = z.object({
  filename: z.string(),
  at: z.string(),
  rowCount: z.number().int().nonnegative(),
  problems: z.array(importProblemSchema).max(IMPORT_PROBLEMS_MAX),
});
export type ImportRecord = z.infer<typeof importRecordSchema>;
