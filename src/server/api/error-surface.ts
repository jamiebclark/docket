import { API_ERROR_CODES, statusFor } from "./errors";
import type { AnyApiOperation } from "./operations";

/** The documented codes that answer with `status`, as a comma-separated backtick list. */
export function codesForStatus(status: number): string {
  return API_ERROR_CODES.filter((c) => statusFor(c) === status)
    .map((c) => `\`${c}\``)
    .join(", ");
}

/** The error statuses `op` can answer with, beyond the ones it documents itself. */
export function errorStatuses(op: AnyApiOperation): number[] {
  const set = new Set<number>([500]);
  if (op.permission !== null) [401, 403, 429].forEach((s) => set.add(s));
  if (op.params || op.resourceParams?.length) set.add(404);
  if (op.query || op.body) set.add(400);
  if (op.idempotent) [400, 409, 413, 415, 422].forEach((s) => set.add(s));
  if (op.body?.kind === "multipart") [413, 415].forEach((s) => set.add(s));
  for (const s of Object.keys(op.responses).map(Number)) set.delete(s);
  return [...set].sort((a, b) => a - b);
}
