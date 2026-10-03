import Link from "next/link";

/** Settings sub-navigation: project settings and members & invitations. */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const base = `/p/${projectSlug}/settings`;
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Settings" className="flex gap-4 border-b border-foreground/20 text-sm">
        <Link href={base} className="px-1 py-2 hover:underline focus-visible:ring-2">
          Project settings
        </Link>
        <Link href={`${base}/members`} className="px-1 py-2 hover:underline focus-visible:ring-2">
          Members &amp; invitations
        </Link>
      </nav>
      {children}
    </div>
  );
}
