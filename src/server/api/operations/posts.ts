import { z } from "zod";
import { PostSchema, TargetResultSchema, TargetSchema, TargetValidationSchema } from "@/lib/api/schemas";
import type { ApiTarget } from "@/lib/api/schemas";
import { atSchema, baseTextSchema, POST_MEDIA_MAX } from "@/lib/validation/scheduling";
import { NotFoundError } from "../../dal/errors";
import type { TargetResult as ServiceTargetResult } from "../../services/posts";
import { addToQueue, createDraft, prepareForScheduling, scheduleAt, validatePost } from "../../services/posts";
import { loadApiPost } from "../../services/views/load";
import { defineOperation } from "./types";

const postIdParams = z.object({ postId: z.uuid() });
const targetParams = z.object({ postId: z.uuid(), targetId: z.uuid() });

const createBody = z.object({
  text: baseTextSchema,
  accountIds: z.array(z.uuid()).min(1).max(50),
  overrides: z.record(z.uuid(), baseTextSchema).optional(),
  mediaIds: z.array(z.uuid()).max(POST_MEDIA_MAX).optional(),
});
const selectBody = z.object({ targetIds: z.array(z.uuid()).optional() });
const scheduleBody = selectBody.extend({ at: atSchema });

interface Issue {
  severity?: string;
  code: string;
  message: string;
  field?: string;
}

function toResult(r: ServiceTargetResult<{ scheduledAt: string; localTime: string; warnings?: readonly { code: string; message: string }[] }>) {
  if (!r.ok) {
    return {
      targetId: r.targetId,
      accountId: r.accountId,
      ok: false as const,
      code: r.code,
      message: r.message,
      ...(r.issues ? { issues: r.issues.map(toIssue) } : {}),
    };
  }
  return {
    targetId: r.targetId,
    accountId: r.accountId,
    ok: true as const,
    scheduledAt: r.scheduledAt,
    scheduledAtLocal: r.localTime,
    ...(r.warnings && r.warnings.length > 0
      ? { warnings: r.warnings.map((w) => ({ severity: "warning", code: w.code, message: w.message })) }
      : {}),
  };
}

function toIssue(i: { severity?: string; code: string; message: string; field?: string }): Issue {
  return { ...(i.severity ? { severity: i.severity } : {}), code: i.code, message: i.message, ...(i.field ? { field: i.field } : {}) };
}

const resultsResponse = z.object({ results: z.array(TargetResultSchema) });

export const postOperations = [
  defineOperation({
    id: "createPost",
    method: "POST",
    path: "/posts",
    permission: "write_posts",
    tag: "Posts",
    summary: "Create a draft post",
    description: "Creates a draft on one or more accounts and reports, per target, whether it would publish as written.",
    body: { kind: "json", schema: createBody },
    responses: {
      201: { description: "The post and its per-target validation", schema: z.object({ post: PostSchema, validation: z.array(TargetValidationSchema) }) },
      400: { description: "Invalid request" },
      404: { description: "An account or image does not exist in this project" },
    },
    idempotent: true,
    async run(scope, { body }) {
      const created = await createDraft(scope, {
        baseText: body.text,
        mediaIds: body.mediaIds ?? [],
        targets: body.accountIds.map((accountId) => ({
          accountId,
          ...(body.overrides?.[accountId] !== undefined ? { overrideText: body.overrides[accountId] } : {}),
        })),
      });
      const issues = await validatePost(scope, created.post.id);
      const byTarget = new Map(issues.map((i) => [i.targetId, i.issues]));
      const validation = created.targets.map((t) => {
        const list = (byTarget.get(t.id) ?? []).map(toIssue);
        return { targetId: t.id, accountId: t.accountId, ok: !list.some((i) => i.severity === "error"), issues: list };
      });
      return { status: 201, body: { post: await loadApiPost(scope, created.post.id), validation } };
    },
  }),
  defineOperation({
    id: "getPost",
    method: "GET",
    path: "/posts/{postId}",
    permission: "read",
    tag: "Posts",
    summary: "Get a post",
    params: postIdParams,
    resourceParams: ["postId"],
    responses: { 200: { description: "The post", schema: PostSchema }, 404: { description: "Not found" } },
    idempotent: false,
    async run(scope, { params }) {
      return { status: 200, body: await loadApiPost(scope, params.postId) };
    },
  }),
  defineOperation({
    id: "getPostTarget",
    method: "GET",
    path: "/posts/{postId}/targets/{targetId}",
    permission: "read",
    tag: "Posts",
    summary: "Get one target of a post",
    params: targetParams,
    resourceParams: ["postId", "targetId"],
    responses: { 200: { description: "The target", schema: TargetSchema }, 404: { description: "Not found" } },
    idempotent: false,
    async run(scope, { params }) {
      const post = await loadApiPost(scope, params.postId);
      const target: ApiTarget | undefined = post.targets.find((t) => t.id === params.targetId);
      if (!target) throw new NotFoundError();
      return { status: 200, body: target };
    },
  }),
  defineOperation({
    id: "queuePost",
    method: "POST",
    path: "/posts/{postId}/queue",
    permission: "write_posts",
    tag: "Posts",
    summary: "Add a post to the queue",
    description: "Each target takes the next free slot of its account. Failures are reported per target in a 200 response.",
    params: postIdParams,
    body: { kind: "json", schema: selectBody },
    resourceParams: ["postId"],
    responses: { 200: { description: "A result per target", schema: resultsResponse }, 404: { description: "Not found" } },
    idempotent: true,
    prepare: (scope, { params, body }) =>
      prepareForScheduling(scope, params.postId, body.targetIds ? { targetIds: body.targetIds } : undefined),
    async run(scope, { params, body }) {
      const results = await addToQueue(scope, params.postId, body.targetIds ? { targetIds: body.targetIds } : {});
      return { status: 200, body: { results: results.map(toResult) } };
    },
  }),
  defineOperation({
    id: "schedulePost",
    method: "POST",
    path: "/posts/{postId}/schedule",
    permission: "write_posts",
    tag: "Posts",
    summary: "Schedule a post at a time",
    description: "`at` is RFC 3339 with an offset, for example `2026-10-04T09:00:00+02:00`. A past instant is reported per target as `in_past`.",
    params: postIdParams,
    body: { kind: "json", schema: scheduleBody },
    resourceParams: ["postId"],
    responses: { 200: { description: "A result per target", schema: resultsResponse }, 404: { description: "Not found" } },
    idempotent: true,
    prepare: (scope, { params, body }) =>
      prepareForScheduling(scope, params.postId, body.targetIds ? { targetIds: body.targetIds } : undefined),
    async run(scope, { params, body }) {
      const results = await scheduleAt(scope, params.postId, {
        at: body.at,
        ...(body.targetIds ? { targetIds: body.targetIds } : {}),
      });
      return { status: 200, body: { results: results.map(toResult) } };
    },
  }),
];
