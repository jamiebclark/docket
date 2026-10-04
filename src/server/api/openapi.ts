import { z } from "zod";
import { createDocument, type ZodOpenApiObject, type ZodOpenApiOperationObject, type ZodOpenApiPathsObject } from "zod-openapi";
import { API_ERROR_CODES, statusFor } from "./errors";
import { OPERATIONS, type AnyApiOperation } from "./operations";

const ErrorSchema = z
  .object({
    error: z.object({
      code: z.enum(API_ERROR_CODES).meta({ description: "Stable machine-readable error code" }),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().meta({ description: "Quote this if you contact support" }),
    }),
  })
  .meta({ id: "Error" });

const REQUEST_ID_HEADER = { description: "Unique id of this request", schema: z.string() };
const RETRY_AFTER_HEADER = { description: "Seconds to wait before retrying", schema: z.string() };
const REPLAYED_HEADER = {
  description: "`true` when this response is the stored result of an earlier request with the same Idempotency-Key",
  schema: z.literal("true"),
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "The request is not valid",
  401: "Missing or invalid API key",
  403: "The key lacks the required permission",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  413: "Request body too large",
  415: "Unsupported media type",
  422: "Unprocessable",
  429: "Rate limited",
  500: "Unexpected error",
  503: "Not configured or unavailable",
};

function codesFor(status: number): string {
  return API_ERROR_CODES.filter((c) => statusFor(c) === status)
    .map((c) => `\`${c}\``)
    .join(", ");
}

function errorResponse(status: number) {
  const headers: Record<string, { description: string; schema: z.ZodType }> = { "X-Request-Id": REQUEST_ID_HEADER };
  if (status === 429 || status === 503) headers["Retry-After"] = RETRY_AFTER_HEADER;
  return {
    description: `${ERROR_DESCRIPTIONS[status] ?? "Error"}. Codes: ${codesFor(status)}.`,
    content: { "application/json": { schema: ErrorSchema } },
    headers,
  };
}

function errorStatuses(op: AnyApiOperation): number[] {
  const set = new Set<number>([500]);
  if (op.permission !== null) [401, 403, 429].forEach((s) => set.add(s));
  if (op.params || op.resourceParams?.length) set.add(404);
  if (op.query || op.body) set.add(400);
  if (op.idempotent) [400, 409, 413, 415, 422].forEach((s) => set.add(s));
  if (op.body?.kind === "multipart") [413, 415].forEach((s) => set.add(s));
  for (const s of Object.keys(op.responses).map(Number)) set.delete(s);
  return [...set].sort((a, b) => a - b);
}

function buildOperation(op: AnyApiOperation): ZodOpenApiOperationObject {
  const responses: Record<string, unknown> = {};
  for (const [status, r] of Object.entries(op.responses)) {
    const headers: Record<string, { description: string; schema: z.ZodType }> = { "X-Request-Id": REQUEST_ID_HEADER };
    if (op.idempotent) headers["Idempotent-Replayed"] = REPLAYED_HEADER;
    responses[status] = {
      description: r.description,
      ...(r.schema ? { content: { "application/json": { schema: r.schema } } } : {}),
      headers,
    };
  }
  for (const s of errorStatuses(op)) responses[String(s)] = errorResponse(s);

  const requestParams: { path?: z.ZodObject; query?: z.ZodObject; header?: z.ZodObject } = {};
  if (op.params) requestParams.path = op.params as unknown as z.ZodObject;
  if (op.query) requestParams.query = op.query as unknown as z.ZodObject;
  if (op.idempotent) {
    requestParams.header = z.object({
      "Idempotency-Key": z
        .string()
        .min(1)
        .max(255)
        .optional()
        .meta({ description: "1 to 255 printable ASCII characters. A retry with the same key replays the first result." }),
    });
  }

  const description = [
    op.description,
    op.permission ? `Requires the \`${op.permission}\` permission.` : "Needs no API key.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    operationId: op.id,
    summary: op.summary,
    description,
    tags: [op.tag],
    security: op.permission === null ? [] : [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    "x-required-permission": op.permission,
    ...(Object.keys(requestParams).length ? { requestParams } : {}),
    ...(op.body
      ? {
          requestBody: {
            required: true,
            content: {
              [op.body.kind === "multipart" ? "multipart/form-data" : "application/json"]: { schema: op.body.schema },
            },
          },
        }
      : {}),
    responses,
  } as ZodOpenApiOperationObject;
}

function build(): Record<string, unknown> {
  const paths: ZodOpenApiPathsObject = {};
  for (const op of OPERATIONS) {
    const item = (paths[op.path] ??= {});
    (item as Record<string, unknown>)[op.method.toLowerCase()] = buildOperation(op);
  }
  const doc: ZodOpenApiObject = {
    openapi: "3.1.0",
    info: {
      title: "Docket public API",
      version: "1.0.0",
      description:
        "Create, queue and schedule posts, manage media and run generation jobs. Authenticate with a project API key as `Authorization: Bearer <key>` or `X-API-Key: <key>`.",
    },
    servers: [{ url: "/api/v1" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Project API key" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key", description: "Project API key" },
      },
    },
  };
  return createDocument(doc, { unusedIO: "input" } as never) as unknown as Record<string, unknown>;
}

let cached: Record<string, unknown> | null = null;

/** Built once per process from the operation table (FR-042). */
export function buildOpenApiDocument(): Record<string, unknown> {
  cached ??= build();
  return cached;
}

/** Test hook: forces a rebuild after a table change. */
export function resetOpenApiDocument(): void {
  cached = null;
}
