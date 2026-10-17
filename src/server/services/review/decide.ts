// services/review/decide: the shared decision core (contracts/services.md §1).
import { NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";

export interface AlreadyDecided {
  ok: false;
  code: "already_decided";
  message: string;
}

export interface Decidable<T> {
  /** `SELECT … FOR UPDATE` inside the caller's transaction. */
  lock(tx: ProjectScope, id: string): Promise<T | null>;
  /** False when the item has already been decided. */
  isUndecided(row: T): boolean;
  /** The refusal message for an already-decided row. */
  decidedMessage(row: T): string;
}

/**
 * Same-process decisions on one row wait their turn here instead of each parking a pooled
 * connection on the row lock: the winner still needs the pool inside its transaction, so a burst
 * of duplicate clicks could otherwise exhaust it. The row lock stays the arbiter across processes.
 */
const decisions = new Map<string, Promise<unknown>>();
export async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = decisions.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  const tail = current.catch(() => undefined);
  decisions.set(key, tail);
  try {
    return await current;
  } finally {
    if (decisions.get(key) === tail) decisions.delete(key);
  }
}

/**
 * Opens the transaction, locks the row, refuses if already decided, and calls `apply`, which
 * writes the decision. The only implementation of "approve" anywhere (FR-032).
 */
export async function decide<T, R>(
  scope: ProjectScope,
  id: string,
  subject: Decidable<T>,
  apply: (tx: ProjectScope, row: T) => Promise<R>,
): Promise<R | AlreadyDecided> {
  return scope.transaction(async (tx): Promise<R | AlreadyDecided> => {
    const row = await subject.lock(tx, id);
    if (!row) throw new NotFoundError();
    if (!subject.isUndecided(row)) return { ok: false, code: "already_decided", message: subject.decidedMessage(row) };
    return apply(tx, row);
  });
}
