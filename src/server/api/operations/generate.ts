import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PostSchema, TargetResultSchema } from "@/lib/api/schemas";
import { approvalPolicySchema, schedulingPolicySchema } from "@/lib/validation/policies";
import { POST_MEDIA_MAX } from "@/lib/validation/scheduling";
import { generateSingle } from "../../services/generation/single";
import { defaultVoiceProfileId } from "../../services/voice";
import { loadApiPost } from "../../services/views/load";
import { apiError } from "../errors";
import { generationRequestIdFor } from "../idempotency";
import { defineOperation } from "./types";

const body = z.object({
  brief: z.string().min(1).max(2000),
  sourceText: z.string().max(50_000).optional(),
  accountIds: z.array(z.uuid()).min(1).max(50),
  mediaIds: z.array(z.uuid()).max(POST_MEDIA_MAX).optional(),
  voiceProfileId: z.uuid().optional(),
  instructions: z.string().max(2000).optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  schedulingPolicy: schedulingPolicySchema.optional(),
  confirmUnreviewedQueue: z.boolean().optional(),
});

/** Model output that was unusable: the caller may retry with a new key. The rest is temporary or configuration. */
const GeneratedSchema = z.object({
  post: PostSchema,
  decision: z.object({ reviewState: z.string(), queue: z.boolean(), reason: z.string() }),
  queued: z.array(TargetResultSchema),
  problems: z.array(z.object({ code: z.string(), message: z.string() })),
});

const UNUSABLE = new Set(["invalid_output", "refused", "incomplete", "bad_request"]);

export const generateOperations = [
  defineOperation({
    id: "generatePost",
    method: "POST",
    path: "/generate",
    permission: "generate",
    tag: "Generation",
    summary: "Generate a post from a brief",
    description:
      "Needs `generate`; `approvalPolicy: auto_approve` also needs `auto_approve`. Auto-approve with add_to_queue needs `confirmUnreviewedQueue: true`.",
    body: { kind: "json", schema: body },
    responses: {
      201: { description: "The generated post", schema: GeneratedSchema },
      200: { description: "The post this request already made", schema: GeneratedSchema },
      400: { description: "Invalid request or confirmation required" },
      422: { description: "The model's output was unusable" },
      503: { description: "No model configured, or the model is unavailable" },
    },
    idempotent: true,
    idempotencyMode: "generate",
    async run(scope, { body: b, idempotencyRecordId }) {
      const voiceProfileId = b.voiceProfileId ?? (await defaultVoiceProfileId(scope));
      if (!voiceProfileId) {
        throw apiError("validation_failed", "The project has no default voice profile. Pass voiceProfileId.", [
          { path: "voiceProfileId", message: "Required when the project has no default voice profile" },
        ]);
      }
      const result = await generateSingle(scope, {
        requestId: idempotencyRecordId ? generationRequestIdFor(idempotencyRecordId) : randomUUID(),
        voiceProfileId,
        brief: b.brief,
        sourceText: b.sourceText,
        instructions: b.instructions,
        targetAccountIds: b.accountIds,
        mediaIds: b.mediaIds ?? [],
        approval: b.approvalPolicy,
        scheduling: b.schedulingPolicy,
        confirmUnreviewedQueue: b.confirmUnreviewedQueue ?? false,
      });
      if (!result.ok) {
        if (UNUSABLE.has(result.kind)) {
          throw apiError("generation_failed", result.message, { kind: result.kind, failureId: result.failureId });
        }
        throw apiError("generation_unavailable", result.message, { kind: result.kind }, { "Retry-After": "30" });
      }
      return {
        status: result.existing ? 200 : 201,
        body: {
          post: await loadApiPost(scope, result.postId),
          decision: result.decision,
          queued: result.queued.map((r) =>
            r.ok
              ? { targetId: r.targetId, accountId: r.accountId, ok: true, scheduledAt: r.scheduledAt, scheduledAtLocal: r.localTime }
              : { targetId: r.targetId, accountId: r.accountId, ok: false, code: r.code, message: r.message },
          ),
          problems: result.remainingProblems.flatMap((p) =>
            p.messages.map((m) => ({ severity: "error", code: "provider_problem", message: `${p.label ?? p.groupKey ?? p.providerKey}: ${m}` })),
          ),
        },
      };
    },
  }),
];
