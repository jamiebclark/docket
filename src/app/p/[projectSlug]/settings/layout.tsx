import { SubNav } from "@/components/ui/SubNav";
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
  const items = [
    { label: "Project settings", href: base },
    { label: "Members & invitations", href: `${base}/members` },
    ...(canManageApi
      ? [
          { label: "API keys", href: `${base}/api-keys` },
          { label: "Webhooks", href: `${base}/webhooks` },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <SubNav label="Settings" items={items} />
      {children}
    </div>
  );
}
