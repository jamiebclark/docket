import { describe, expect, it } from "vitest";
import { EXPOSED } from "@/server/mcp/dispositions";
import { argumentNamesFor, argumentSchemaFor, inputSchemaFor } from "@/server/mcp/schema";

function hasRefLike(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRefLike);
  if (!node || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if ("$ref" in obj || "$defs" in obj || "$schema" in obj) return true;
  return Object.values(obj).some(hasRefLike);
}

describe("inputSchemaFor", () => {
  it("has no $ref/$defs/$schema for any exposed operation", () => {
    for (const op of EXPOSED) {
      const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
      const schema = inputSchemaFor(op, confirm);
      expect(hasRefLike(schema)).toBe(false);
    }
  });
});

describe("argumentSchemaFor / argumentNamesFor", () => {
  it("property names equal exactly the operation's params+query+body fields plus confirm/idempotencyKey where applicable", () => {
    for (const op of EXPOSED) {
      const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
      const names = argumentNamesFor(op);
      const expected = new Set([...names.params, ...names.query, ...names.body]);
      if (confirm) expected.add("confirm");
      if (op.idempotent) expected.add("idempotencyKey");

      const schema = argumentSchemaFor(op, confirm);
      expect(new Set(Object.keys(schema.shape))).toEqual(expected);
    }
  });

  it("fails naming the operation on a path/query/body name collision across the whole table", () => {
    const collisions: string[] = [];
    for (const op of EXPOSED) {
      const { params, query, body } = argumentNamesFor(op);
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const n of [...params, ...query, ...body]) {
        if (seen.has(n)) dupes.add(n);
        seen.add(n);
      }
      if (dupes.size > 0) collisions.push(`${op.id}: ${[...dupes].join(", ")}`);
    }
    expect(collisions).toEqual([]);
  });
});
