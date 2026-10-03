import Link from "next/link";

export default function ProjectNotFound() {
  return (
    <main id="main" className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/" className="text-sm underline focus-visible:ring-2">
        Go to Docket
      </Link>
    </main>
  );
}
