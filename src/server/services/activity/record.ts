import type { ActivityRepo, NewActivityEvent } from "../../dal/activity";
import { now } from "../../dal/clock";
import { needsReauthEvent } from "./classify";

// Thin writers: each runs on the transaction handle its caller already holds, so an event commits or rolls back with the change it describes.

/** Anything with the activity repo; a scheduler or project transaction qualifies. */
interface HasActivity {
  activity: Pick<ActivityRepo, "insert">;
}

interface HasAccounts {
  accounts: { get(id: string): Promise<{ id: string; providerKey: string; lastError: string | null } | null> };
}

/** Writes the event; a `null` event (a transition that is not worth a row) is a no-op. */
export async function recordTargetEvent(tx: HasActivity, event: NewActivityEvent | null): Promise<void> {
  if (event) await tx.activity.insert(event);
}

/** Call only when the account really moved from active to needs_reauth, in the transaction that moved it. */
export async function recordAccountNeedsReauth(
  tx: HasActivity & HasAccounts,
  accountId: string,
  reason: "renewal_refused" | "credentials_invalid",
  at?: Date,
): Promise<void> {
  const account = await tx.accounts.get(accountId);
  if (!account) return;
  await tx.activity.insert(needsReauthEvent({ account, reason, message: account.lastError, now: at ?? (await now()) }));
}

/** A connect failure; written in the failing request's own transaction where there is one. */
export async function recordConnectFailed(scope: HasActivity, event: NewActivityEvent): Promise<void> {
  await scope.activity.insert(event);
}
