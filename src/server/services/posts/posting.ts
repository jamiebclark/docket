import { z } from "zod";
import { findProvider } from "../../../providers/registry";
import type { ProjectScope } from "../../dal/scope";
import { readAccountDetails } from "../account-details";
import { recordConsentOnSave } from "./consent";
import { loadTargetContent } from "./validate";

interface TargetInput {
  accountId: string;
  posting?: unknown;
  consent?: { fingerprint: string } | null | undefined;
}

/**
 * The `posting_fields` column change for one submitted target (G25). Absent keeps the stored value, null clears it,
 * a provider without `posting` ignores it. An unparsable value is a 400 at `targets.<i>.posting`.
 */
export function postingColumn(providerKey: string, raw: unknown, index: number): { postingFields?: unknown } {
  const provider = findProvider(providerKey);
  if (raw === undefined || !provider?.posting) return {};
  if (raw === null) return { postingFields: null };
  const parsed = provider.posting.valuesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new z.ZodError([{ code: "custom", path: ["targets", index, "posting"], message: "These posting options aren't valid." }]);
  }
  return { postingFields: parsed.data };
}

/**
 * Live account details for each target whose save carries a consent, read before the save transaction opens (G26).
 * A failed read is simply absent: the consent is then not recorded.
 */
export async function liveDetailsFor(scope: ProjectScope, targets: readonly TargetInput[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const t of targets) {
    if (!t.consent?.fingerprint) continue;
    const account = await scope.accounts.get(t.accountId);
    const provider = account ? findProvider(account.providerKey) : undefined;
    if (!account || !provider?.consent || !provider.accountDetails) continue;
    const r = await readAccountDetails(scope, account.id);
    if (r.ok) out.set(account.id, r.details);
  }
  return out;
}

/** After a save: records the consent that was sent and clears any that the save made stale, for every target of the post. */
export async function settleConsent(
  tx: ProjectScope,
  postId: string,
  sent: ReadonlyMap<string, TargetInput>,
  details: ReadonlyMap<string, unknown>,
): Promise<void> {
  for (const target of await tx.targets.listForPost(postId)) {
    const account = await tx.accounts.get(target.socialAccountId);
    const provider = account ? findProvider(account.providerKey) : undefined;
    if (!account || !provider?.consent) continue;
    const content = await loadTargetContent(tx, target);
    if (!content) continue;
    await recordConsentOnSave(tx, target, provider, content, { consent: sent.get(account.id)?.consent }, details.get(account.id) ?? null);
  }
}
