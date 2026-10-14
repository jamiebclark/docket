import { OPERATIONS } from "@/server/api/operations";
import type { AnyApiOperation } from "@/server/api/operations/types";

/** Every operation whose disposition exposes it as a tool, in table order. */
export const EXPOSED: readonly AnyApiOperation[] = OPERATIONS.filter((op) => op.mcp.expose);

/** Every withheld operation and the reason published for it. */
export const WITHHELD: readonly { id: string; reason: string }[] = OPERATIONS.filter((op) => !op.mcp.expose).map((op) => ({
  id: op.id,
  reason: op.mcp.expose ? "" : op.mcp.reason,
}));

/**
 * One human-readable problem per malformed disposition, naming the operation id.
 * Empty for a well-formed table (data-model.md §1 validation rules).
 */
export function dispositionProblems(ops: readonly AnyApiOperation[]): string[] {
  const problems: string[] = [];
  for (const op of ops) {
    if (!op.mcp) {
      problems.push(`${op.id}: missing mcp disposition`);
      continue;
    }
    if (!op.mcp.expose) {
      if (!op.mcp.reason || op.mcp.reason.trim() === "") {
        problems.push(`${op.id}: withheld with an empty reason`);
      }
      continue;
    }
    if (op.permission === null) {
      problems.push(`${op.id}: exposed but has no permission (an unauthenticated tool cannot exist)`);
    }
    if (op.body?.kind === "multipart") {
      problems.push(`${op.id}: exposed but accepts multipart body (a JSON tool call cannot carry bytes)`);
    }
    const confirm = op.mcp.confirm;
    if (confirm) {
      if (!confirm.effect || confirm.effect.trim() === "") {
        problems.push(`${op.id}: confirm.effect is empty`);
      }
      if (confirm.when && !confirm.whenDescription) {
        problems.push(`${op.id}: confirm.when is set but confirm.whenDescription is missing`);
      }
      if (!confirm.when && confirm.whenDescription) {
        problems.push(`${op.id}: confirm.whenDescription is set but confirm.when is missing`);
      }
    }
  }
  return problems;
}
