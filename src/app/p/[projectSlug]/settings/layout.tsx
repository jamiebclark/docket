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
  const scope = await forProject(await getSession(), projectSlug).catch(() => null);
  // Keys and the model credential are owner/admin only; each sub-nav link follows its own permission.
  const canManageApi = scope?.can({ api_key: ["manage"] }) ?? false;
  const canManageLlm = scope?.can({ llm_credential: ["manage"] }) ?? false;
  const items = [
    { label: "Project settings", href: base },
    { label: "Members & invitations", href: `${base}/members` },
    ...(canManageApi
      ? [
          { label: "API keys", href: `${base}/api-keys` },
          { label: "Webhooks", href: `${base}/webhooks` },
        ]
      : []),
    ...(canManageLlm ? [{ label: "Model & API key", href: `${base}/model` }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      <SubNav label="Settings" items={items} />
      {children}
    </div>
  );
}
