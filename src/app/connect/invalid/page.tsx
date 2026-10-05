import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/brand/AuthShell";
import { buttonStyles } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Connection not valid" };

export default function ConnectInvalidPage() {
  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold">Connect accounts</h1>
      <p role="alert" className="text-sm text-muted-foreground">
        This connection attempt has expired or is not valid. Start again.
      </p>
      <Link href="/" className={buttonStyles({ variant: "primary", className: "self-start" })}>
        Back to Docket
      </Link>
    </AuthShell>
  );
}
