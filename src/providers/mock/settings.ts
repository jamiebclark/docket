import { z } from "zod";

/** A scripted inbound item for the mock provider's `engagement.read()` (tested with no platform credentials). */
export const mockEngagementItemSchema = z.object({
  kind: z.enum(["reply", "comment", "mention", "direct_message"]),
  externalId: z.string().min(1),
  text: z.string(),
  authorDisplayName: z.string().nullable().default(null),
  authorHandle: z.string().nullable().default(null),
  authorExternalId: z.string().nullable().default(null),
  identityStable: z.boolean().default(false),
  saidAt: z.string().default(() => new Date().toISOString()),
  parentExternalId: z.string().nullable().default(null),
});
export type MockEngagementItem = z.infer<typeof mockEngagementItemSchema>;

export const mockEngagementSendBehaviours = ["sent", "duplicate", "ambiguous", "fatal_error", "credentials_invalid"] as const;

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
  /** The engagement surface is declared but unavailable, with a reason and no call ever made (FR-055). */
  engagementUnavailable: z.boolean().default(false),
  /** Items `engagement.read()` returns, as a single exhausted page, so ingest is testable with no credentials. */
  engagementItems: z.array(mockEngagementItemSchema).default([]),
  engagementSendBehaviour: z.enum(mockEngagementSendBehaviours).default("sent"),
});

export type MockSettings = z.infer<typeof mockSettingsSchema>;
export type MockState = { done: number; video?: "uploaded" | "polled" };
