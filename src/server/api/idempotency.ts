import { createHash } from "node:crypto";
import type { ProjectScope } from "../dal/scope";
import { parseLlmConfig } from "../llm/config";
import { ApiError, apiError, mapServiceError } from "./errors";
import type { AnyApiOperation, ApiRunResult } from "./operations";
import { errorBody } from "./respond";

const MIN_HOLD_SECONDS = 300;
const DEFAULT_LLM_TIMEOUT_SECONDS = 90;

/** How long a claim holds the key: two model calls plus saving, never under five minutes (research D8). */
export function holdMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseLlmConfig(env);
  const timeoutSeconds = parsed.ok ? parsed.config.timeoutMs / 1000 : DEFAULT_LLM_TIMEOUT_SECONDS;
  return Math.max(MIN_HOLD_SECONDS, 2 * timeoutSeconds + 120) * 1000;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Canonical JSON: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value ?? {}));
}

/**
 * The body hash of research D9. JSON hashes its canonical form. Multipart hashes each file's bytes plus the
 * canonical text fields, because the boundary changes on every request.
 */
export async function hashBody(raw: unknown): Promise<string> {
  const h = createHash("sha256");
  if (raw instanceof FormData) {
    const fields: Record<string, string | string[]> = {};
    const files: { name: string; file: File }[] = [];
    for (const [name, v] of raw.entries()) {
      if (typeof v === "string") {
        const prior = fields[name];
        fields[name] = prior === undefined ? v : Array.isArray(prior) ? [...prior, v] : [prior, v];
      } else files.push({ name, file: v });
    }
    h.update(canonicalJson(fields));
    for (const { name, file } of files.sort((a, b) => a.name.localeCompare(b.name))) {
      h.update(`\0file:${name}:${file.size}\0`);
      h.update(new Uint8Array(await file.arrayBuffer()));
    }
    return h.digest("hex");
  }
  return h.update(canonicalJson(raw)).digest("hex");
}

/** The id `POST /generate` passes to `generateSingle`, linking the post to the key through 007's unique index. */
export function generationRequestIdFor(recordId: string): string {
  const hex = createHash("sha256").update(`idem:${recordId}`).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export interface IdempotencyRequest {
  op: AnyApiOperation;
  scope: ProjectScope;
  method: string;
  /** The concrete path without the query. */
  route: string;
  idemKey: string;
  rawBody: unknown;
  requestId: string;
  /** Parses params, query and body. Runs after the claim, so a 400 is stored and replayed (D10). */
  parse: () => { params: unknown; query: unknown; body: unknown };
}

/** A returned 5xx: handed back to the caller but neither stored nor committed. */
class Unstored extends Error {
  constructor(readonly result: ApiRunResult) {
    super("unstored");
  }
}

function holdLost(): ApiError {
  return apiError("idempotency_in_progress", "Another request took over this Idempotency-Key. Retry shortly.", undefined, {
    "Retry-After": "1",
  });
}

/** What a thrown error becomes when it is a stored answer (status < 500); null when it is not. */
function storable(e: unknown, permission: string | null, requestId: string): ApiRunResult | null {
  const mapped = mapServiceError(e, { permission });
  if (mapped.status >= 500) return null;
  return { status: mapped.status, body: errorBody(mapped, requestId) };
}

/**
 * Wraps an operation in the idempotency protocol of research D8: claim first, run the effect, store the
 * result. The effect and the stored result commit together, except for `generate` and `self_commit` modes.
 * `generate` links the effect to the key through the post's request id; `self_commit` services commit per item.
 */
export async function runIdempotent(req: IdempotencyRequest): Promise<ApiRunResult> {
  const { op, scope, requestId } = req;
  if (!scope.actor || scope.actor.kind !== "api_key") throw new Error("idempotency needs an API key scope");
  const claim = await scope.idempotency.claim({
    apiKeyId: scope.actor.apiKeyId,
    method: req.method,
    route: req.route,
    idemKey: req.idemKey,
    bodyHash: await hashBody(req.rawBody),
    holdMs: holdMs(),
  });
  if (claim.kind === "replay") return { status: claim.status, body: claim.body, headers: { "Idempotent-Replayed": "true" } };
  if (claim.kind === "mismatch") {
    throw apiError("idempotency_key_reused", "This Idempotency-Key was already used with a different request.");
  }
  if (claim.kind === "in_progress") {
    throw apiError("idempotency_in_progress", "A request with this Idempotency-Key is still running.", undefined, {
      "Retry-After": String(claim.retryAfterSeconds),
    });
  }

  const { recordId, token } = claim;
  const release = async () => {
    try {
      await scope.idempotency.release(recordId, token);
    } catch {
      // The hold expires on its own; never mask the original error.
    }
  };
  const store = async (r: ApiRunResult) => {
    if (!(await scope.idempotency.complete(recordId, token, r.status, r.body))) throw holdLost();
  };

  try {
    let input: ReturnType<IdempotencyRequest["parse"]>;
    let prepared: unknown;
    try {
      input = req.parse();
      prepared = op.prepare ? await op.prepare(scope, input) : undefined;
    } catch (e) {
      const answer = storable(e, op.permission, requestId);
      if (!answer) throw e;
      await store(answer);
      return answer;
    }
    const runInput = { ...input, prepared, requestId, idempotencyRecordId: recordId };

    if (op.idempotencyMode === "generate" || op.idempotencyMode === "self_commit") {
      let out: ApiRunResult;
      try {
        out = await op.run(scope, runInput);
      } catch (e) {
        const answer = storable(e, op.permission, requestId);
        if (!answer) throw e;
        out = answer;
      }
      if (out.status >= 500) throw new Unstored(out);
      // The post is already committed and linked to the key; a lost hold only means a retry returns that same post.
      await scope.idempotency.complete(recordId, token, out.status, out.body);
      return out;
    }

    return await scope.transaction(async (tx) => {
      let out: ApiRunResult;
      try {
        out = await tx.transaction((s) => op.run(s, runInput));
      } catch (e) {
        const answer = storable(e, op.permission, requestId);
        if (!answer) throw e;
        out = answer;
      }
      if (out.status >= 500) throw new Unstored(out);
      if (!(await tx.idempotency.complete(recordId, token, out.status, out.body))) throw holdLost();
      return out;
    });
  } catch (e) {
    await release();
    if (e instanceof Unstored) return e.result;
    throw e;
  }
}
