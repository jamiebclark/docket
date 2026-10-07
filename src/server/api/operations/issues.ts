/** Shared shapes for validation issues and warnings in API results. */
export interface Issue {
  severity?: string;
  code: string;
  message: string;
  field?: string;
}

export function toIssue(i: { severity?: string; code: string; message: string; field?: string }): Issue {
  return { ...(i.severity ? { severity: i.severity } : {}), code: i.code, message: i.message, ...(i.field ? { field: i.field } : {}) };
}

export function toWarning(w: { code: string; message: string }): { severity: "warning"; code: string; message: string } {
  return { severity: "warning", code: w.code, message: w.message };
}
