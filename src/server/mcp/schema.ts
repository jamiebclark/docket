import { z } from "zod";
import type { AnyApiOperation, McpConfirm } from "@/server/api/operations/types";

/**
 * The field shape of `schema`: a plain object's own shape, or the merged shape of a union's
 * branches (e.g. `updateSlot`'s body, which is either `{weekday, localTime}` or `{paused}`).
 */
function shapeOf(schema: z.ZodType | undefined): Record<string, z.ZodType> {
  if (!schema) return {};
  const s = schema as unknown as { shape?: Record<string, z.ZodType>; options?: z.ZodType[] };
  if (s.shape) return s.shape;
  if (s.options) {
    const merged: Record<string, z.ZodType> = {};
    for (const option of s.options) Object.assign(merged, shapeOf(option));
    return merged;
  }
  return {};
}

/** Which group each argument of `op` belongs to, so the bridge can route it (contracts/mcp-transport.md §5). */
export function argumentNamesFor(op: AnyApiOperation): { params: string[]; query: string[]; body: string[] } {
  return {
    params: Object.keys(shapeOf(op.params)),
    query: Object.keys(shapeOf(op.query)),
    body: op.body?.kind === "json" ? Object.keys(shapeOf(op.body.schema)) : [],
  };
}

/** The flat merge of params, query, body, plus `confirm`/`idempotencyKey` where the disposition asks for it (data-model.md §4). */
export function argumentSchemaFor(op: AnyApiOperation, confirm?: McpConfirm): z.ZodObject {
  const shape: Record<string, z.ZodType> = {
    ...shapeOf(op.params),
    ...shapeOf(op.query),
    ...(op.body?.kind === "json" ? shapeOf(op.body.schema) : {}),
  };
  if (confirm) shape.confirm = confirm.when ? z.literal(true).optional() : z.literal(true);
  if (op.idempotent) shape.idempotencyKey = z.string().min(1).max(255).optional();
  return z.object(shape);
}

/** Replaces every local `$ref` with its `$defs` entry, then drops `$defs`/`$schema` (research D7). */
function inlineRefs(node: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const key = ref.slice("#/$defs/".length);
    const target = inlineRefs(defs[key], defs) as Record<string, unknown>;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$ref") continue;
      rest[k] = inlineRefs(v, defs);
    }
    return { ...target, ...rest };
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$defs" || k === "$schema") continue;
    result[k] = inlineRefs(v, defs);
  }
  return result;
}

/** Self-contained JSON Schema for `op`'s arguments: no `$ref`, `$defs` or `$schema` (research D7). */
export function inputSchemaFor(op: AnyApiOperation, confirm?: McpConfirm): Record<string, unknown> {
  const schema = argumentSchemaFor(op, confirm);
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  const defs = (json.$defs as Record<string, unknown>) ?? {};
  return inlineRefs(json, defs) as Record<string, unknown>;
}
