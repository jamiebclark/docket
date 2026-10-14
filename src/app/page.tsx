import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/brand/AuthShell";
import { OperatorStatement } from "@/components/public/OperatorStatement";
import { buttonStyles } from "@/components/ui/Button";
import { linkStyles } from "@/components/ui/controls";
import { ProviderIcon } from "@/components/ui/Icon";
import { listProviders } from "@/providers/registry";
import { getSession } from "@/server/auth/session";
import { getPublicSite } from "@/server/public-site";
import * as projects from "@/server/services/projects";
import * as setup from "@/server/services/setup";
import { decideAnonymousRedirect, decideRootRedirect } from "./root-redirect";

export const metadata: Metadata = {
  title: { absolute: "Docket" },
  description:
    "A self-hosted tool for planning, scheduling and publishing posts to the operator's own social accounts. Access is by invitation.",
};
export const dynamic = "force-dynamic";

/** Every real platform, from the registry, so this page never names one Docket cannot post to. */
function platforms() {
  return listProviders().filter((p) => p.key !== "mock");
}

/**
 * "/" sends a signed-in user to their remembered, earliest or a new project (FR-018), and a fresh install to
 * /setup. Anybody else — including a platform reviewer — gets a public description of the installation.
 */
export default async function Home() {
  const session = await getSession();
  if (!session) {
    const first = decideAnonymousRedirect(await setup.isAvailable());
    if (first) redirect(first);
    return <PublicHome />;
  }
  const [mine, jar] = await Promise.all([projects.listMine(session), cookies()]);
  redirect(decideRootRedirect(jar.get("docket_last_project")?.value, mine));
}

function PublicHome() {
  const site = getPublicSite();
  return (
    <AuthShell width="lg" current="home">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Self-hosted social post scheduling</h1>
        <p className="text-sm text-muted-foreground">
          Docket is a self-hosted tool for planning, scheduling and publishing posts for the operator&apos;s own brands
          to their own connected social accounts.
        </p>
      </div>

      <section aria-labelledby="platforms" className="flex flex-col gap-2">
        <h2 id="platforms" className="text-sm font-medium">
          Publishes to
        </h2>
        <ul className="flex flex-wrap gap-2">
          {platforms().map((p) => (
            <li key={p.key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-3 pl-1 text-sm">
              <ProviderIcon providerKey={p.key} size={22} className="rounded-full" />
              {p.displayName}
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-2 text-sm">
        <p>
          It is not a social network: there are no public profiles or feeds, and no public sign-up. Access is by
          invitation from the operator.
        </p>
        <OperatorStatement site={site} />
      </div>

      <Link href="/login" className={buttonStyles({ variant: "primary", size: "lg", className: "w-full" })}>
        Log in
      </Link>
      <p className="text-sm text-muted-foreground">
        How this installation handles data:{" "}
        <Link href="/privacy" className={linkStyles}>
          Privacy Policy
        </Link>
      </p>
    </AuthShell>
  );
}
