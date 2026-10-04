import { randomUUID } from "node:crypto";
import { z } from "zod";
import { idempotencyKeySchema } from "@/lib/validation/api";
import * as clock from "../dal/clock";
import { InvalidApiKeyError } from "../dal/errors";
import { forApiKey, type ProjectScope } from "../dal/scope";
import { getEnv } from "../env";
import { readKey } from "./auth";
import { ApiError, apiError, logUnexpected, mapServiceError, zodDetails } from "./errors";
import type { AnyApiOperation } from "./operations";
import { runIdempotent } from "./idempotency";
import { allowedMethods, matchOperation } from "./router";
import { baseHeaders, errorResponse, json } from "./respond";

/** Interim limits (contracts/http-api.md): JSON up to 8 MB; multipart up to the image limit plus 1 MB. */
export const JSON_BODY_LIMIT = 8 * 1024 * 1024;
const MULTIPART_EXTRA = 1024 * 1024;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function multipartLimit(): number {
  return getEnv().media.maxUploadBytes + MULTIPART_EXTRA;
}

/** Reads the body as bytes within `limit`, checking the declared length first. */
async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw apiError("payload_too_large", "The request body is too large.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw apiError("payload_too_large", "The request body is too large.");
  return bytes;
}

async function readBody(request: Request, op: AnyApiOperation): Promise<unknown> {
  if (!op.body) return undefined;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (op.body.kind === "multipart") {
    if (!type.startsWith("multipart/form-data")) {
      throw apiError("unsupported_media_type", "Send this request as multipart/form-data.");
    }
    const bytes = await readBytes(request, multipartLimit());
    try {
      return await new Response(bytes as BodyInit, { headers: { "content-type": type } }).formData();
    } catch {
      throw apiError("validation_failed", "The multipart body could not be read.");
    }
  }
  const bytes = await readBytes(request, JSON_BODY_LIMIT);
  if (bytes.byteLength === 0) return {};
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/.test(type)) {
    throw apiError("unsupported_media_type", "Send this request as application/json.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw apiError("invalid_json", "The request body is not valid JSON.");
  }
}

function parseWith(schema: z.ZodType | undefined, value: unknown): unknown {
  if (!schema) return value;
  const r = schema.safeParse(value);
  if (!r.success) throw apiError("validation_failed", "The request is not valid.", zodDetails(r.error));
  return r.data;
}

const UUID = z.uuid();

function parseInput(op: AnyApiOperation, rawParams: Record<string, string>, url: URL, rawBody: unknown) {
  for (const [name, value] of Object.entries(rawParams)) {
    if (name.endsWith("Id") && !UUID.safeParse(value).success) throw apiError("not_found", "Not found.");
  }
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length === 1 ? all[0]! : all;
  }
  return {
    params: parseWith(op.params, rawParams),
    query: parseWith(op.query, query),
    body: parseWith(op.body?.schema, rawBody),
  };
}

function retryAfterSeconds(resetAt: Date, now: Date): number {
  return Math.min(60, Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)));
}

/** Runs the operation. Idempotency wraps this step for writes (research D8). */
async function execute(
  op: AnyApiOperation,
  scope: ProjectScope,
  input: { params: unknown; query: unknown; body: unknown },
  requestId: string,
) {
  const prepared = op.prepare ? await op.prepare(scope, input) : undefined;
  return op.run(scope, { ...input, prepared, requestId, idempotencyRecordId: null });
}

/** The pipeline of research D7. Steps 1–8 store nothing. */
export async function handleApiRequest(request: Request, segments: string[]): Promise<Response> {
  const requestId = randomUUID();
  let permission: string | null = null;
  try {
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") {
      const allow = allowedMethods(segments);
      if (allow.length === 0) throw apiError("not_found", "Not found.");
      return new Response(null, { status: 204, headers: baseHeaders(requestId, { Allow: allow.join(", ") }) });
    }

    const match = matchOperation(method, segments);
    if (match.kind === "not_found") throw apiError("not_found", "Not found.");
    if (match.kind === "method_not_allowed") {
      throw apiError("method_not_allowed", "That method is not allowed here.", undefined, { Allow: match.allow.join(", ") });
    }
    const { op } = match;
    permission = op.permission;

    if (op.permission === null) {
      // Public, read-only and cacheable: no key, no scope, no idempotency.
      const r = await op.run(null as unknown as ProjectScope, {
        params: {}, query: {}, body: undefined, prepared: undefined, requestId, idempotencyRecordId: null,
      });
      const res = json(requestId, r.status, r.body);
      for (const [k, v] of Object.entries(r.headers ?? {})) res.headers.set(k, v);
      return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
    }

    let scope: ProjectScope | null = null;
    if (op.permission !== null) {
      const key = readKey(request.headers);
      if (key === null || key === "conflict") throw new InvalidApiKeyError();
      const authed = await forApiKey(key);
      scope = authed.scope;
      if (authed.rate.count > authed.rate.limit) {
        const wait = retryAfterSeconds(authed.rate.resetAt, await clock.now());
        throw apiError("rate_limited", "Too many requests. Slow down and retry.", undefined, { "Retry-After": String(wait) });
      }
      if (!scope.actor || scope.actor.kind !== "api_key" || !scope.actor.permissions.includes(op.permission)) {
        throw apiError("missing_permission", `This key needs the ${op.permission} permission.`, { permission: op.permission });
      }
    }

    const rawBody = await readBody(request, op);
    let idemKey: string | null = null;
    if (WRITE_METHODS.has(method) && op.idempotent) {
      idemKey = request.headers.get("idempotency-key");
      if (idemKey !== null && !idempotencyKeySchema.safeParse(idemKey).success) {
        throw apiError("invalid_idempotency_key", "Idempotency-Key must be 1 to 255 printable ASCII characters.");
      }
    }

    if (scope === null) throw new Error("operation without a permission must not reach the service step");
    const url = new URL(request.url);
    const parse = () => parseInput(op, match.params, url, rawBody);
    const result =
      idemKey === null
        ? await execute(op, scope, parse(), requestId)
        : await runIdempotent({ op, scope, method, route: `/${segments.join("/")}`, idemKey, rawBody, requestId, parse });
    const res = json(requestId, result.status, result.body, result.headers);
    return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  } catch (e) {
    const mapped = e instanceof ApiError ? e : mapServiceError(e, { permission });
    if (mapped.code === "internal_error") logUnexpected(requestId, e);
    const res = errorResponse(requestId, mapped);
    return request.method.toUpperCase() === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  }
}
