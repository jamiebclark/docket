import type { Metadata } from "next";
import { AuthShell } from "@/components/brand/AuthShell";
import { getPublicSite } from "@/server/public-site";
import { POLICY_LAST_UPDATED, POLICY_TITLE, PrivacyPolicy } from "./policy";

// `absolute`: platform reviewers look for a page titled exactly "Privacy Policy".
export const metadata: Metadata = {
  title: { absolute: POLICY_TITLE },
  description: "What this Docket installation stores, what it sends where, and how to delete it.",
};

/** Public (no session needed, see src/lib/auth-gate.ts): the URL to give Pinterest, Meta and other platforms. */
export default function PrivacyPage() {
  const site = getPublicSite();
  return (
    <AuthShell width="prose" current="privacy">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{POLICY_TITLE}</h1>
        <p className="text-sm text-muted-foreground">Last updated {POLICY_LAST_UPDATED}</p>
      </header>
      <PrivacyPolicy site={site} />
    </AuthShell>
  );
}
