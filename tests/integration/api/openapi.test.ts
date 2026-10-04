import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApiDocument, resetOpenApiDocument } from "../../../src/server/api/openapi";
import { defineOperation, OPERATIONS } from "../../../src/server/api/operations";
import { matchOperation } from "../../../src/server/api/router";
import { api } from "../../helpers/api";
import { closeDb } from "../../helpers/db";

afterAll(closeDb);

/* eslint-disable @typescript-eslint/no-explicit-any -- the document is arbitrary JSON */
function doc(): any {
  return buildOpenApiDocument();
}

function operations(): { path: string; method: string; op: any }[] {
  const out: { path: string; method: string; op: any }[] = [];
  for (const [path, item] of Object.entries<any>(doc().paths)) {
    for (const [method, op] of Object.entries<any>(item)) out.push({ path, method, op });
  }
  return out;
}

function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

function resolve(ref: string): unknown {
  expect(ref.startsWith("#/")).toBe(true);
  return ref
    .slice(2)
    .split("/")
    .reduce<any>((n, part) => n?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], doc());
}

describe("openapi.json", () => {
  it("is served without a key, cacheable, as OpenAPI 3.1", async () => {
    const r = await api("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe("3.1.0");
    expect(r.headers.get("cache-control")).toContain("max-age");
    expect(r.headers.get("cache-control")).not.toContain("no-store");
    expect(r.headers.get("x-request-id")).toBeTruthy();
  });

  it("is built once per process", () => {
    expect(buildOpenApiDocument()).toBe(buildOpenApiDocument());
  });

  it("resolves every $ref", () => {
    const all = refs(doc());
    expect(all.length).toBeGreaterThan(0);
    for (const ref of all) expect(resolve(ref), ref).toBeTruthy();
  });

  it("has unique operation ids", () => {
    const ids = operations().map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("documents exactly the operations that are served", () => {
    const documented = operations().map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
    const served = OPERATIONS.map((o) => `${o.method} ${o.path}`).sort();
    expect(documented).toEqual(served);
    for (const { path, method, op } of operations()) {
      const m = matchOperation(method.toUpperCase(), path.split("/").filter(Boolean));
      expect(m.kind, `${method} ${path}`).toBe("match");
      if (m.kind === "match") expect(m.op.id).toBe(op.operationId);
    }
  });

  it("gives each operation security, a permission, a request schema where it takes one, and error responses", () => {
    expect(doc().components.securitySchemes.bearerAuth).toBeTruthy();
    expect(doc().components.securitySchemes.apiKeyHeader).toMatchObject({ type: "apiKey", in: "header", name: "X-API-Key" });
    for (const { path, method, op } of operations()) {
      const label = `${method} ${path}`;
      const src = OPERATIONS.find((o) => o.id === op.operationId)!;
      expect(op["x-required-permission"], label).toBe(src.permission);
      if (src.permission === null) {
        expect(op.security, label).toEqual([]);
        continue;
      }
      expect(op.security, label).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }]);
      for (const status of ["401", "403", "429", "500"]) {
        expect(op.responses[status]?.content?.["application/json"]?.schema, `${label} ${status}`).toBeTruthy();
      }
      if (src.body) {
        const type = src.body.kind === "multipart" ? "multipart/form-data" : "application/json";
        expect(op.requestBody?.content?.[type]?.schema, label).toBeTruthy();
      }
      if (src.idempotent) {
        const names = (op.parameters ?? []).map((p: any) => p.name);
        expect(names, label).toContain("Idempotency-Key");
        expect(op.responses["409"], label).toBeTruthy();
        expect(JSON.stringify(op.responses), label).toContain("Idempotent-Replayed");
      }
    }
  });

  it("documents the shared Error schema with its codes and Retry-After on 429", () => {
    const schema = doc().components.schemas.Error;
    expect(JSON.stringify(schema)).toContain("rate_limited");
    const op = operations().find((o) => o.op.operationId === "listAccounts")!.op;
    expect(op.responses["429"].headers["Retry-After"]).toBeTruthy();
    expect(op.responses["401"].headers["X-Request-Id"]).toBeTruthy();
  });

  it("gives every error response (status >= 400) the shared Error schema, codes and headers", () => {
    let checked = 0;
    for (const { path, method, op } of operations()) {
      for (const [status, res] of Object.entries<any>(op.responses)) {
        if (Number(status) < 400) continue;
        const label = `${method.toUpperCase()} ${path} ${status}`;
        expect(res.content?.["application/json"]?.schema?.$ref, label).toBe("#/components/schemas/Error");
        expect(res.description, label).toContain("Codes:");
        expect(res.headers?.["X-Request-Id"], label).toBeTruthy();
        if (status === "429" || status === "503") expect(res.headers?.["Retry-After"], label).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    const generate = operations().find((o) => o.op.operationId === "generatePost")!.op;
    expect(generate.responses["503"].description).toContain("No model configured");
    expect(generate.responses["200"].content["application/json"].schema).toEqual(
      generate.responses["201"].content["application/json"].schema,
    );
  });

  it("changes when an operation's schema changes", () => {
    const fixture = defineOperation({
      id: "testFixture",
      method: "POST",
      path: "/test/fixture",
      permission: "read",
      tag: "Test",
      summary: "Fixture",
      responses: { 200: { description: "ok" } },
      idempotent: true,
      body: { kind: "json", schema: z.object({ fixtureField: z.string() }) },
      async run() {
        return { status: 200, body: {} };
      },
    });
    const before = JSON.stringify(doc());
    expect(before).not.toContain("fixtureField");
    (OPERATIONS as unknown as unknown[]).push(fixture);
    try {
      resetOpenApiDocument();
      expect(JSON.stringify(doc())).toContain("fixtureField");
    } finally {
      (OPERATIONS as unknown as unknown[]).pop();
      resetOpenApiDocument();
    }
    expect(JSON.stringify(doc())).toBe(before);
  });

  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(JSON.parse(JSON.stringify(doc())));
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});
