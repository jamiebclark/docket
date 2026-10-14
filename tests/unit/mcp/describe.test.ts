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
      }
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
