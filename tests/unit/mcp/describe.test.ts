import { describe, expect, it } from "vitest";
import { codesForStatus, errorStatuses } from "@/server/api/error-surface";
import { EXPOSED } from "@/server/mcp/dispositions";
import { describeTool } from "@/server/mcp/describe";

const project = { name: "Acme Co" };

describe("describeTool", () => {
  it("contains the project name, the permission value and every derived failure code", () => {
    for (const op of EXPOSED) {
      const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
      const text = describeTool(op, project, confirm);

      expect(text).toContain(project.name);
      expect(text).toContain(`\`${op.permission}\``);

      for (const status of errorStatuses(op)) {
        const codes = codesForStatus(status);
        if (!codes) continue;
        expect(text).toContain(codes);
      }

      if (confirm) {
        expect(text).toContain(confirm.effect);
        expect(text.toLowerCase()).toContain("confirm");
        // A conditional gate must publish its condition, not just its effect (review F16).
        if (confirm.whenDescription) expect(text).toContain(confirm.whenDescription);
      }
    }
  });

  it("names the condition for a conditional confirmation, and adds nothing for an unconditional one", () => {
    const conditional = EXPOSED.filter((o) => o.mcp.expose && o.mcp.confirm?.when);
    const unconditional = EXPOSED.filter((o) => o.mcp.expose && o.mcp.confirm && !o.mcp.confirm.when);

    // Both sets must be non-empty, or this test proves nothing about the distinction.
    expect(conditional.length).toBeGreaterThan(0);
    expect(unconditional.length).toBeGreaterThan(0);

    for (const op of conditional) {
      const confirm = op.mcp.expose ? op.mcp.confirm! : undefined!;
      const text = describeTool(op, project, confirm);
      // The escape hatch has to reach the model, not only docs/mcp.md.
      expect(text).toContain(confirm.whenDescription!);
      expect(text).toMatch(/leave_as_draft/);
    }

    for (const op of unconditional) {
      const confirm = op.mcp.expose ? op.mcp.confirm! : undefined!;
      const text = describeTool(op, project, confirm);
      expect(text).toContain(`Requires \`confirm: true\` to proceed: ${confirm.effect}`);
      expect(confirm.whenDescription).toBeUndefined();
    }
  });

  it("names each operation's own documented failures, not only its residual statuses", () => {
    const createProject = EXPOSED.find((o) => o.id === "createProject")!;
    expect(describeTool(createProject, project, undefined)).toContain("`conflict`");

    const getPost = EXPOSED.find((o) => o.id === "getPost")!;
    expect(describeTool(getPost, project, undefined)).toContain("`not_found`");
  });

  it("states the generate budget, auto-approve and validation-forces-review facts for docket_generate_post", () => {
    const op = EXPOSED.find((o) => o.id === "generatePost")!;
    const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
    const text = describeTool(op, project, confirm);

    expect(text).toMatch(/LLM|generation budget/i);
    expect(text).toMatch(/auto_approve/);
    expect(text).toMatch(/validation failure/i);
    expect(text).toMatch(/forces review/i);
  });
});
