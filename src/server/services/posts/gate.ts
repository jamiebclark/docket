import type { ValidationIssue } from "@/providers/types";
import type { AccountRecord } from "../../dal/accounts";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import type { TargetFailureCode } from "./index";
import { loadTargetContent, validateTargetContent } from "./validate";

type Tx = ProjectScope;

/** Validation of the effective content; `null` when the account's provider is unavailable. */
export async function issuesFor(tx: Tx, target: TargetRecord, account: AccountRecord): Promise<ValidationIssue[] | null> {
  const content = await loadTargetContent(tx, target);
  if (!content) return null;
  return validateTargetContent(tx, account, content);
}

export const errorsOf = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "error");

export type Gate =
  | { ok: true; account: AccountRecord; issues: ValidationIssue[] }
  | { ok: false; code: TargetFailureCode; message: string; issues?: ValidationIssue[] };

/** Account usable, provider registered, validation clean (FR-024–FR-028). */
export async function gate(tx: Tx, target: TargetRecord): Promise<Gate> {
  const account = await tx.accounts.get(target.socialAccountId);
  if (!account) return { ok: false, code: "account_unavailable", message: "That account has been removed." };
  if (account.status !== "active") {
    return { ok: false, code: "account_unavailable", message: `${account.displayName} needs to be reconnected.` };
  }
  const issues = await issuesFor(tx, target, account);
  if (issues === null) {
    return { ok: false, code: "account_unavailable", message: `The provider for ${account.displayName} is no longer available.` };
  }
  const errors = errorsOf(issues);
  if (errors.length > 0) {
    return { ok: false, code: "validation", message: errors[0]!.message, issues };
  }
  return { ok: true, account, issues };
}

