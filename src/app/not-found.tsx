import Link from "next/link";
import { AuthShell } from "@/components/brand/AuthShell";
import { buttonStyles } from "@/components/ui/Button";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <AuthShell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      </div>
      <Link href="/" className={buttonStyles({ variant: "primary", className: "self-start" })}>
        Go to Docket
      </Link>
    </AuthShell>
  );
}
