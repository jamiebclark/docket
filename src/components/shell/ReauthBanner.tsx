import Link from "next/link";
import { alertStyles } from "@/components/ui/Alert";

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
  askNames = "an owner or admin",
}: {
  accounts: ReauthAccount[];
  projectSlug: string;
  canManage: boolean;
  /** Who to ask when the viewer can't reconnect: `askManagers(managers, "or")`. */
  askNames?: string;
}) {
  if (accounts.length === 0) return null;
  return (
    <div role="alert" className={alertStyles("warning", true)}>
      <p className="font-semibold">
        {accounts.length === 1 ? "An account needs reconnecting" : `${accounts.length} accounts need reconnecting`}. Posts to{" "}
        {accounts.length === 1 ? "it" : "them"} will not go out until it is fixed.
      </p>
      <ul className="mt-1 list-disc pl-5">
        {accounts.map((a) => (
          <li key={a.id}>
            {canManage ? (
              <Link href={`/p/${projectSlug}/accounts#account-${a.id}`} className="font-medium underline underline-offset-2">
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
      {canManage ? null : <p className="mt-1">Ask {askNames} to reconnect {accounts.length === 1 ? "it" : "them"}.</p>}
    </div>
  );
}
