import { z } from "zod";
import { buildOpenApiDocument } from "../openapi";
import { defineOperation } from "./types";

export const openApiOperations = [
  defineOperation({
    id: "getOpenApi",
    method: "GET",
    path: "/openapi.json",
    permission: null,
    tag: "Meta",
    summary: "Get this OpenAPI document",
    responses: { 200: { description: "The OpenAPI 3.1 document", schema: z.record(z.string(), z.unknown()) } },
    idempotent: false,
    async run() {
      return { status: 200, body: buildOpenApiDocument(), headers: { "Cache-Control": "public, max-age=300" } };
    },
  }),
];
