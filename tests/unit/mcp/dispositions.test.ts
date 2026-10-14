import { describe, expect, it } from "vitest";
import { dispositionProblems } from "@/server/mcp/dispositions";
import { OPERATIONS, type AnyApiOperation } from "@/server/api/operations";
import { defineOperation } from "@/server/api/operations/types";

const base = OPERATIONS.find((op) => op.id === "listAccounts")!;

function fixture(overrides: Partial<AnyApiOperation>): AnyApiOperation {
  return defineOperation({ ...base, ...overrides } as never);
}

describe("dispositionProblems", () => {
  it("is empty for OPERATIONS", () => {
    expect(dispositionProblems(OPERATIONS)).toEqual([]);
  });

  it("names the operation when its disposition is removed", () => {
    const op = { ...base } as Record<string, unknown>;
    delete op.mcp;
    const problems = dispositionProblems([op as unknown as AnyApiOperation]);
    expect(problems.some((p) => p.includes(base.id))).toBe(true);
  });

  it("names the operation when a withheld reason is empty", () => {
    const op = fixture({ mcp: { expose: false, reason: "" } });
    const problems = dispositionProblems([op]);
    expect(problems.some((p) => p.includes(op.id))).toBe(true);
  });

  it("names the operation when confirm is missing effect", () => {
    const op = fixture({ mcp: { expose: true, confirm: { effect: "" } } });
    const problems = dispositionProblems([op]);
    expect(problems.some((p) => p.includes(op.id))).toBe(true);
  });

  it("names the operation when confirm.when has no whenDescription", () => {
    const op = fixture({ mcp: { expose: true, confirm: { effect: "Do a thing.", when: () => true } } });
    const problems = dispositionProblems([op]);
    expect(problems.some((p) => p.includes(op.id))).toBe(true);
  });
});
