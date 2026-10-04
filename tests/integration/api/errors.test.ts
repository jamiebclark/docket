import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { ErrorSchema } from "../../../src/lib/api/schemas";
import { API_ERROR_CODES, mapServiceError, statusFor } from "../../../src/server/api/errors";
import { defineOperation, OPERATIONS } from "../../../src/server/api/operations";
import {
  ConflictError,
  ForbiddenError,
  InvalidApiKeyError,
  JobClosedError,
  JobItemLimitError,
  MediaReservedError,
  NotFoundError,
  PolicyNotAllowedError,
  UrlFetchError,
  ValidationIssuesError,
} from "../../../src/server/dal/errors";
import { LlmNotConfiguredError } from "../../../src/server/llm";
import { StorageUnavailableError } from "../../../src/server/storage/errors";
import { api, createKey, type ApiResult } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

const echo = defineOperation({
  id: "testErrorsEcho",
  method: "POST",
  path: "/test/errors",
  permission: "read",
  tag: "Test",
  summary: "Echo",
  responses: { 200: { description: "ok" } },
  idempotent: true,
  body: { kind: "json", schema: z.object({ n: z.number() }) },
  async run() {
    throw new Error("select * from api_keys where key_hash = 'deadbeef' at /srv/app/node_modules/pg/lib.js:12");
  },
});
beforeAll(() => {
  (OPERATIONS as unknown as unknown[]).push(echo);
});
afterAll(async () => {
  (OPERATIONS as unknown as unknown[]).splice((OPERATIONS as unknown as unknown[]).indexOf(echo), 1);
  await closeDb();
});

describe("error responses", () => {
  it("every error matches the Error schema, uses a documented code, and leaks nothing", async () => {
    const env = await postsEnv();
    const read = await createKey(env.scope, ["read"]);
    const gen = await createKey(env.scope, ["generate"]);
    const limited = await createKey(env.scope, ["read"], { rateLimitPerMinute: 1 });
    await api("GET", "/accounts", { key: limited.secret });

    const seen: ApiResult[] = [
      await api("GET", "/accounts"),
      await api("GET", "/accounts", { key: gen.secret }),
      await api("GET", "/nope", { key: read.secret }),
      await api("DELETE", "/accounts", { key: read.secret }),
      await api("POST", "/test/errors", { key: read.secret, body: { n: "x" } }),
      await api("POST", "/test/errors", { key: read.secret, body: "{", headers: { "content-type": "application/json" } }),
      await api("POST", "/test/errors", { key: read.secret, body: "x", headers: { "content-type": "text/plain" } }),
      await api("POST", "/test/errors", { key: read.secret, body: { n: 1 }, idem: "bad key" }),
      await api("POST", "/test/errors", { key: read.secret, body: { n: 1 } }),
      await api("GET", "/accounts", { key: limited.secret }),
    ];
    const codes = new Set<string>();
    for (const r of seen) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      const parsed = z.object({ error: ErrorSchema.shape.error }).safeParse(r.json);
      expect(parsed.success, r.text).toBe(true);
      const err = r.json.error;
      expect(API_ERROR_CODES).toContain(err.code);
      expect(statusFor(err.code)).toBe(r.status);
      expect(err.requestId).toBe(r.headers.get("x-request-id"));
      for (const secret of [read.secret, gen.secret, limited.secret]) expect(r.text).not.toContain(secret);
      expect(r.text).not.toMatch(/node_modules|select \* from|key_hash|\bat \S+:\d+/i);
      codes.add(err.code);
    }
    expect([...codes].sort()).toEqual(
      [
        "internal_error",
        "invalid_api_key",
        "invalid_idempotency_key",
        "invalid_json",
        "method_not_allowed",
        "missing_permission",
        "not_found",
        "rate_limited",
        "unsupported_media_type",
        "validation_failed",
      ].sort(),
    );
    const forbidden = seen[1]!;
    expect(forbidden.json.error.details).toEqual({ permission: "read" });
    expect(seen[8]!.json.error.message).not.toMatch(/api_keys|deadbeef/);
  });
});

describe("mapServiceError", () => {
  const ctx = { permission: "write_posts" };
  const cases: [string, unknown, string, number][] = [
    ["NotFoundError", new NotFoundError(), "not_found", 404],
    ["ForbiddenError", new ForbiddenError(), "missing_permission", 403],
    ["PolicyNotAllowedError", new PolicyNotAllowedError("Not allowed", "approval"), "missing_permission", 403],
    ["ConflictError", new ConflictError("That slot was just taken."), "conflict", 409],
    ["JobClosedError", new JobClosedError(), "job_closed", 409],
    ["MediaReservedError", new MediaReservedError([{ index: 0, mediaId: "m", reason: "reserved" }]), "media_reserved", 409],
    ["JobItemLimitError", new JobItemLimitError(), "job_item_limit", 400],
    ["ValidationIssuesError", new ValidationIssuesError([{ code: "x", message: "y" }]), "validation_failed", 400],
    ["LlmNotConfiguredError", new LlmNotConfiguredError(["LLM_API_KEY"]), "generation_not_configured", 503],
    ["StorageUnavailableError", new StorageUnavailableError(), "storage_not_configured", 503],
    ["UrlFetchError", new UrlFetchError("url_timeout", "timed out"), "url_timeout", 400],
    ["InvalidApiKeyError", new InvalidApiKeyError(), "invalid_api_key", 401],
    ["unknown", new Error("boom: select 1"), "internal_error", 500],
  ];
  it.each(cases)("%s", (_name, error, code, status) => {
    const mapped = mapServiceError(error, ctx);
    expect(mapped.code).toBe(code);
    expect(mapped.status).toBe(status);
    if (code === "internal_error") expect(mapped.message).not.toContain("boom");
  });

  it("maps a ZodError on confirmUnreviewedQueue to confirmation_required, others to validation_failed", () => {
    const schema = z.object({ confirmUnreviewedQueue: z.literal(true) });
    const confirm = schema.safeParse({});
    const other = z.object({ a: z.string() }).safeParse({});
    expect(mapServiceError(confirm.error as ZodError, ctx).code).toBe("confirmation_required");
    expect(mapServiceError(other.error as ZodError, ctx).code).toBe("validation_failed");
  });

  it("names the permission on a forbidden error", () => {
    expect(mapServiceError(new ForbiddenError(), ctx).details).toEqual({ permission: "write_posts" });
    expect(mapServiceError(new PolicyNotAllowedError("Not allowed", "approval"), ctx).details).toEqual({ permission: "auto_approve" });
  });
});
