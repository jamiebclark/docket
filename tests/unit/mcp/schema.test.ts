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

describe("inputSchemaFor's required array", () => {
  it("omits confirm from required for a conditional confirmation tool, and includes it for an unconditional one", () => {
    const conditional = EXPOSED.find((op) => op.mcp.expose && op.mcp.confirm?.when)!;
    const unconditional = EXPOSED.find((op) => op.mcp.expose && op.mcp.confirm && !op.mcp.confirm.when)!;
    expect(conditional).toBeDefined();
    expect(unconditional).toBeDefined();

    const conditionalSchema = inputSchemaFor(conditional, conditional.mcp.expose ? conditional.mcp.confirm : undefined) as {
      required?: string[];
    };
    const unconditionalSchema = inputSchemaFor(unconditional, unconditional.mcp.expose ? unconditional.mcp.confirm : undefined) as {
      required?: string[];
    };

    expect(conditionalSchema.required ?? []).not.toContain("confirm");
    expect(unconditionalSchema.required ?? []).toContain("confirm");
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
