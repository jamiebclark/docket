import { z } from "zod";

export const mockBehaviours = [
  "succeed",
  "multi_step",
  "retryable",
  "fatal",
  "ambiguous",
  "rate_limited",
  "throw",
] as const;

export const mockSettingsSchema = z.object({
  behaviour: z.enum(mockBehaviours).default("succeed"),
  /** multi_step: continues before the publish step */
  steps: z.number().int().min(1).max(10).default(1),
  /** retryable: fail the first N attempts, then succeed; omitted = always */
  failTimes: z.number().int().min(1).max(100).optional(),
  /** rate_limited: how far ahead `notBefore` is */
  retryAfterSeconds: z.number().int().min(1).max(86400).default(300),
  /** slow provider (respects ctx.signal) */
  delayMs: z.number().int().min(0).max(60000).default(0),
  refresh: z.enum(["succeed", "fail"]).default("succeed"),
});

export type MockSettings = z.infer<typeof mockSettingsSchema>;
export type MockState = { done: number };
