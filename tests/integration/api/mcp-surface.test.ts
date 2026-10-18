import { describe, expect, it } from "vitest";
import { OPERATIONS, type AnyApiOperation } from "@/server/api/operations";
import { describeTool } from "@/server/mcp/describe";
import { dispositionProblems, EXPOSED } from "@/server/mcp/dispositions";
import { PUBLISHED_TOOL_NAMES, toolNameFor } from "@/server/mcp/naming";
import { argumentNamesFor, inputSchemaFor } from "@/server/mcp/schema";

const project = { name: "Drift Test Project" };

describe("the MCP surface derivation (no drift)", () => {
  it("has no disposition problems over OPERATIONS", () => {
    expect(dispositionProblems(OPERATIONS)).toEqual([]);
  });

  it("derives exactly the 21 exposed operations as tools, no orphans, no un-toolled exposures", () => {
    expect(EXPOSED).toHaveLength(21);
    const exposedIds = new Set(EXPOSED.map((op) => op.id));
    const actuallyExposedIds = new Set(OPERATIONS.filter((op) => op.mcp.expose).map((op) => op.id));
    expect(exposedIds).toEqual(actuallyExposedIds);
  });

  it("tool names equal PUBLISHED_TOOL_NAMES", () => {
    expect(EXPOSED.map((op) => toolNameFor(op.id))).toEqual(PUBLISHED_TOOL_NAMES);
  });

  it("each tool's permission and input-schema field set matches its operation", () => {
    for (const op of EXPOSED) {
      const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
      const description = describeTool(op, project, confirm);
      expect(description).toContain(`\`${op.permission}\``);

      const names = argumentNamesFor(op);
      const expectedFields = new Set([...names.params, ...names.query, ...names.body]);
      if (confirm) expectedFields.add("confirm");
      if (op.idempotent) expectedFields.add("idempotencyKey");

      const schema = inputSchemaFor(op, confirm) as { properties?: Record<string, unknown> };
      expect(new Set(Object.keys(schema.properties ?? {}))).toEqual(expectedFields);
    }
  });

  it("fails naming the operation when the mcp field is deleted from a local fixture", () => {
    const base = OPERATIONS.find((op) => op.id === "listAccounts")!;
    const broken: Record<string, unknown> = { ...base };
    delete broken.mcp;
    const fixtureTable = [broken as unknown as AnyApiOperation];
    const problems = dispositionProblems(fixtureTable);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes(base.id))).toBe(true);
  });
});
