import { z } from "zod";
import { JobItemSchema, JobSchema, JobSummarySchema } from "@/lib/api/schemas";
import { appendItemsSchema, apiSourceInputSchema } from "@/lib/validation/api";
import { JOB_TEMPLATE_MAX } from "@/lib/validation/jobs";
import { approvalPolicySchema, schedulingPolicySchema } from "@/lib/validation/policies";
import { NotFoundError } from "../../dal/errors";
import {
  appendItems,
  cancelJob,
  closeJob,
  createJob,
  retryFailedItems,
} from "../../services/jobs";
import { loadApiJob, loadApiJobItem, loadApiJobItems, loadApiJobSummaries } from "../../services/views/load";
import { apiError } from "../errors";
import { decodeCursor, pageOf, pageQuerySchema } from "../pagination";
import { defineOperation } from "./types";

const jobIdParams = z.object({ jobId: z.uuid() });
const itemParams = z.object({ jobId: z.uuid(), itemId: z.uuid() });

const mediaSelection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pick"), ids: z.array(z.uuid()).min(1).max(500) }),
  z.object({
    mode: z.literal("filter"),
    filter: z.object({ tag: z.string().max(50).optional(), missingAlt: z.boolean().optional(), q: z.string().max(100).optional() }),
  }),
  z.object({ mode: z.literal("unused") }),
]);

const createBody = z.object({
  source: z.discriminatedUnion("kind", [
    apiSourceInputSchema,
    z.object({ kind: z.literal("media"), selection: mediaSelection, includeUsed: z.boolean().optional() }),
    z.object({ kind: z.literal("csv") }),
  ]),
  template: z.string().min(1).max(JOB_TEMPLATE_MAX),
  accountIds: z.array(z.uuid()).min(1).max(50),
  voiceProfileId: z.uuid(),
  approvalPolicy: approvalPolicySchema.optional(),
  schedulingPolicy: schedulingPolicySchema.optional(),
  confirmUnreviewedQueue: z.boolean().optional(),
});

const itemsQuery = pageQuerySchema.extend({
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]).optional(),
});

export const jobOperations = [
  defineOperation({
    id: "listJobs",
    method: "GET",
    path: "/jobs",
    permission: "read",
    tag: "Jobs",
    summary: "List generation jobs",
    query: pageQuerySchema,
    responses: { 200: { description: "A page of jobs", schema: z.object({ data: z.array(JobSummarySchema), nextCursor: z.string().nullable() }) } },
    idempotent: false,
    async run(scope, { query }) {
      const offset = decodeCursor(query.cursor);
      if (offset === null) throw apiError("validation_failed", "The cursor is not valid.");
      const { rows } = await scope.jobs.list({ limit: query.limit + 1, offset });
      const page = pageOf(rows, query.limit, offset);
      return { status: 200, body: { data: await loadApiJobSummaries(scope, page.data), nextCursor: page.nextCursor } };
    },
  }),
  defineOperation({
    id: "createJob",
    method: "POST",
    path: "/jobs",
    permission: "manage_jobs",
    tag: "Jobs",
    summary: "Create a generation job",
    description:
      "`source.kind: \"api\"` takes declared `fields` and optional first `items`; with `open: true` more items can be added later and the job finishes once it is closed. `media` takes an image selection. CSV jobs are created in the app. `approvalPolicy: auto_approve` also needs `auto_approve`.",
    body: { kind: "json", schema: createBody },
    responses: {
      201: { description: "The job", schema: JobSchema },
      400: { description: "Invalid request" },
      409: { description: "An image is reserved by another job" },
      503: { description: "No model configured" },
    },
    idempotent: true,
    async run(scope, { body: b }) {
      const source =
        b.source.kind === "media" ? { ...b.source, includeUsed: b.source.includeUsed ?? false } : b.source;
      const result = await createJob(scope, {
        source,
        voiceProfileId: b.voiceProfileId,
        template: b.template,
        targetAccountIds: b.accountIds,
        approval: b.approvalPolicy,
        scheduling: b.schedulingPolicy,
        confirmUnreviewedQueue: b.confirmUnreviewedQueue ?? false,
      });
      return { status: 201, body: await loadApiJob(scope, result.jobId) };
    },
  }),
  defineOperation({
    id: "getJob",
    method: "GET",
    path: "/jobs/{jobId}",
    permission: "read",
    tag: "Jobs",
    summary: "Get one job",
    params: jobIdParams,
    resourceParams: ["jobId"],
    responses: { 200: { description: "The job", schema: JobSchema }, 404: { description: "Not found" } },
    idempotent: false,
    async run(scope, { params }) {
      return { status: 200, body: await loadApiJob(scope, params.jobId) };
    },
  }),
  defineOperation({
    id: "listJobItems",
    method: "GET",
    path: "/jobs/{jobId}/items",
    permission: "read",
    tag: "Jobs",
    summary: "List a job's items",
    params: jobIdParams,
    query: itemsQuery,
    resourceParams: ["jobId"],
    responses: { 200: { description: "A page of items", schema: z.object({ data: z.array(JobItemSchema), nextCursor: z.string().nullable() }) } },
    idempotent: false,
    async run(scope, { params, query }) {
      const offset = decodeCursor(query.cursor);
      if (offset === null) throw apiError("validation_failed", "The cursor is not valid.");
      if (!(await scope.jobs.get(params.jobId))) throw new NotFoundError();
      const rows = await loadApiJobItems(scope, params.jobId, {
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit + 1,
        offset,
      });
      const page = pageOf(rows, query.limit, offset);
      return { status: 200, body: { data: page.data, nextCursor: page.nextCursor } };
    },
  }),
  defineOperation({
    id: "getJobItem",
    method: "GET",
    path: "/jobs/{jobId}/items/{itemId}",
    permission: "read",
    tag: "Jobs",
    summary: "Get one job item",
    params: itemParams,
    resourceParams: ["jobId", "itemId"],
    responses: { 200: { description: "The item", schema: JobItemSchema }, 404: { description: "Not found" } },
    idempotent: false,
    async run(scope, { params }) {
      return { status: 200, body: await loadApiJobItem(scope, params.jobId, params.itemId) };
    },
  }),
  defineOperation({
    id: "addJobItems",
    method: "POST",
    path: "/jobs/{jobId}/items",
    permission: "manage_jobs",
    tag: "Jobs",
    summary: "Add items to an open job",
    description: "1–100 items per call, at most 500 per job. All items are added or none are.",
    params: jobIdParams,
    body: { kind: "json", schema: appendItemsSchema },
    resourceParams: ["jobId"],
    responses: {
      201: {
        description: "The items added",
        schema: z.object({
          added: z.number().int(),
          itemCount: z.number().int(),
          items: z.array(z.object({ id: z.uuid(), position: z.number().int() })),
        }),
      },
      400: { description: "Invalid items, or the job would exceed 500 items" },
      409: { description: "The job is closed, or an image is reserved" },
    },
    idempotent: true,
    async run(scope, { params, body }) {
      return { status: 201, body: await appendItems(scope, params.jobId, body) };
    },
  }),
  defineOperation({
    id: "closeJob",
    method: "POST",
    path: "/jobs/{jobId}/close",
    permission: "manage_jobs",
    tag: "Jobs",
    summary: "Close an open job",
    description: "No more items can be added. The job finishes once every item is done. An empty job cannot be closed.",
    params: jobIdParams,
    resourceParams: ["jobId"],
    responses: { 200: { description: "The job", schema: JobSchema }, 409: { description: "The job has no items" } },
    idempotent: true,
    async run(scope, { params }) {
      await closeJob(scope, params.jobId);
      return { status: 200, body: await loadApiJob(scope, params.jobId) };
    },
  }),
  defineOperation({
    id: "cancelJob",
    method: "POST",
    path: "/jobs/{jobId}/cancel",
    permission: "manage_jobs",
    tag: "Jobs",
    summary: "Cancel a job",
    params: jobIdParams,
    resourceParams: ["jobId"],
    responses: { 200: { description: "The job and how many items were cancelled", schema: z.object({ job: JobSchema, cancelled: z.number().int() }) } },
    idempotent: true,
    async run(scope, { params }) {
      const result = await cancelJob(scope, params.jobId);
      return { status: 200, body: { job: await loadApiJob(scope, params.jobId), cancelled: result.count } };
    },
  }),
  defineOperation({
    id: "retryFailedJobItems",
    method: "POST",
    path: "/jobs/{jobId}/retry-failed",
    permission: "manage_jobs",
    tag: "Jobs",
    summary: "Retry a job's failed items",
    params: jobIdParams,
    resourceParams: ["jobId"],
    responses: { 200: { description: "The job and how many items were retried", schema: z.object({ job: JobSchema, retried: z.number().int() }) } },
    idempotent: true,
    async run(scope, { params }) {
      const result = await retryFailedItems(scope, params.jobId);
      return { status: 200, body: { job: await loadApiJob(scope, params.jobId), retried: result.count } };
    },
  }),
];
