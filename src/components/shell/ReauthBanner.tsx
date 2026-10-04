import Link from "next/link";

export interface ReauthAccount {
  id: string;
  displayName: string;
  providerName: string;
}

/**
 * App-wide warning that accounts need reconnecting (SC-008). Pure over its props; renders nothing when
 * there are none. Owners and admins get a link to the account; everyone else is told whom to ask.
 */
export function ReauthBanner({
  accounts,
  projectSlug,
  canManage,
}: {
  accounts: ReauthAccount[];
  projectSlug: string;
  canManage: boolean;
}) {
  if (accounts.length === 0) return null;
  return (
    <div role="alert" className="border-b border-amber-700 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">
        {accounts.length === 1 ? "An account needs reconnecting" : `${accounts.length} accounts need reconnecting`}. Posts to{" "}
        {accounts.length === 1 ? "it" : "them"} will not go out until it is fixed.
      </p>
      <ul className="mt-1 list-disc pl-5">
        {accounts.map((a) => (
          <li key={a.id}>
            {canManage ? (
              <Link href={`/p/${projectSlug}/accounts#account-${a.id}`} className="underline">
                {a.displayName} ({a.providerName})
              </Link>
            ) : (
              <>
                {a.displayName} ({a.providerName})
              </>
            )}
          </li>
        ))}
      </ul>
      {canManage ? null : <p className="mt-1">Ask an owner or admin to reconnect {accounts.length === 1 ? "it" : "them"}.</p>}
    </div>
  );
}
