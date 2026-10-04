import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Connection not valid" };

export default function ConnectInvalidPage() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Connect accounts</h1>
      <p role="alert">This connection attempt has expired or is not valid. Start again.</p>
      <Link href="/" className="underline">
        Back to Docket
      </Link>
    </main>
  );
}
