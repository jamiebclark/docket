"use client";

export default function ProjectError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-sm">We couldn&apos;t load this page. Try again.</p>
      <button type="button" onClick={reset} className="rounded border border-foreground/30 px-3 py-1.5 text-sm focus-visible:ring-2">
        Try again
      </button>
    </section>
  );
}
