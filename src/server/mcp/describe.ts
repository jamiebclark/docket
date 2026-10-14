import { codesForStatus, errorStatuses } from "@/server/api/error-surface";
import type { AnyApiOperation, McpConfirm } from "@/server/api/operations/types";
import type { ProjectScope } from "@/server/dal/scope";
import { EXPOSED } from "./dispositions";
import { toolNameFor } from "./naming";
import { inputSchemaFor } from "./schema";
import type { McpTool } from "./types";

/** The four required parts (data-model.md §5), plus confirmation/generate-specific sentences. */
export function describeTool(op: AnyApiOperation, project: { name: string }, confirm?: McpConfirm): string {
  const parts: string[] = [op.summary, op.description].filter((s): s is string => Boolean(s));

  parts.push(`Acts only on the "${project.name}" project — the one this key belongs to — and cannot act on any other project.`);
  parts.push(`Requires the \`${op.permission}\` permission.`);

  const documented = Object.keys(op.responses)
    .map(Number)
    .filter((s) => s >= 400);
  const statuses = [...new Set([...errorStatuses(op), ...documented])].sort((a, b) => a - b);
  const codes = statuses.map((s) => codesForStatus(s)).filter(Boolean);
  if (codes.length) parts.push(`Can fail with: ${codes.join(", ")}.`);

  if (confirm) {
    parts.push(`Requires \`confirm: true\` to proceed: ${confirm.effect}`);
  }

  if (op.id === "generatePost") {
    parts.push(
      "This spends the project's LLM generation budget. `approvalPolicy: auto_approve` skips human review before the post is queued or scheduled. A validation failure in the generated content always forces review, even with `auto_approve`.",
    );
  }

  return parts.join(" ");
}

/** One tool per exposed operation, in table order (data-model.md §3). */
export function toolsFor(scope: ProjectScope): McpTool[] {
  return EXPOSED.map((op) => {
    const confirm = op.mcp.expose ? op.mcp.confirm : undefined;
    return {
      name: toolNameFor(op.id),
      title: op.summary,
      description: describeTool(op, scope.project, confirm),
      inputSchema: inputSchemaFor(op, confirm),
      operation: op,
      // EXPOSED already excludes the one operation with permission: null (getOpenApi, withheld).
      permission: op.permission as NonNullable<AnyApiOperation["permission"]>,
      ...(confirm ? { confirm } : {}),
    };
  });
}
