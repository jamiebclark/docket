import type { z } from "zod";
import type { ApiKeyPermission } from "@/server/dal/api-keys";
import type { ProjectScope } from "@/server/dal/scope";

export interface ApiRunInput<P = unknown, Q = unknown, B = unknown> {
  params: P;
  query: Q;
  body: B;
  prepared: unknown;
  requestId: string;
  idempotencyRecordId: string | null;
}

export interface ApiRunResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The single list the router, OpenAPI document and tests use (FR-047, FR-048). */
/** Named OpenAPI examples. */
export type ApiExamples = Record<string, { summary: string; value: unknown }>;

export interface ApiOperation<P = unknown, Q = unknown, B = unknown> {
  id: string;
  method: "GET" | "POST";
  /** "/posts/{postId}/queue" */
  path: string;
  /** null only for the public `getOpenApi`. */
  permission: ApiKeyPermission | null;
  summary: string;
  description?: string;
  tag: string;
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?:
    | { kind: "json"; schema: z.ZodType<B>; examples?: ApiExamples }
    | { kind: "multipart"; schema: z.ZodType<B>; examples?: ApiExamples };
  responses: Record<number, { description: string; schema?: z.ZodType; examples?: ApiExamples }>;
  /** Writes: true. The pipeline applies research D8 around `run`. */
  idempotent: boolean;
  /**
   * `generate` and `self_commit` run the operation outside the idempotent transaction. `self_commit` is for
   * operations whose services commit per item, so a failure part-way must not roll back the finished items.
   */
  idempotencyMode?: "transaction" | "generate" | "self_commit";
  /** Slow, repeatable pre-work run before the idempotent transaction. Never commits a business effect. */
  prepare?: (scope: ProjectScope, input: { params: P; query: Q; body: B }) => Promise<unknown>;
  /** Calls exactly one service and maps its result. */
  run: (scope: ProjectScope, input: ApiRunInput<P, Q, B>) => Promise<ApiRunResult>;
  /** For the scope test (FR-048): which path params name project resources. */
  resourceParams?: ("postId" | "targetId" | "mediaId" | "jobId" | "itemId")[];
}

// Operations have different parameter types; the table stores them erased and the pipeline parses with each schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- erased element type of the table
export type AnyApiOperation = ApiOperation<any, any, any>;

export function defineOperation<P = unknown, Q = unknown, B = unknown>(op: ApiOperation<P, Q, B>): AnyApiOperation {
  return op as AnyApiOperation;
}

