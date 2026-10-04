import Link from "next/link";
import { getSession } from "@/server/auth/session";
import { forProject } from "@/server/dal";

/** Settings sub-navigation: project settings, members & invitations, and API keys. */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const base = `/p/${projectSlug}/settings`;
  // Keys are owner/admin only; the sub-nav link follows the same permission as the page.
  const canManageApi = await forProject(await getSession(), projectSlug)
    .then((scope) => scope.can({ api_key: ["manage"] }))
    .catch(() => false);
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Settings" className="flex gap-4 border-b border-foreground/20 text-sm">
        <Link href={base} className="px-1 py-2 hover:underline focus-visible:ring-2">
          Project settings
        </Link>
        <Link href={`${base}/members`} className="px-1 py-2 hover:underline focus-visible:ring-2">
          Members &amp; invitations
        </Link>
        {canManageApi ? (
          <Link href={`${base}/api-keys`} className="px-1 py-2 hover:underline focus-visible:ring-2">
            API keys
          </Link>
        ) : null}
        {canManageApi ? (
          <Link href={`${base}/webhooks`} className="px-1 py-2 hover:underline focus-visible:ring-2">
            Webhooks
          </Link>
        ) : null}
      </nav>
      {children}
    </div>
  );
}
