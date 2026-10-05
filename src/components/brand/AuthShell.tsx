import type { ReactNode } from "react";
import { Logo } from "./Logo";

/**
 * Frame for signed-out and first-run pages (log in, set up, invitation sign-up): a soft lavender
 * brand backdrop with one centred card. Renders the page's `<main id="main">` landmark.
 */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -right-32 size-[34rem] rounded-full bg-brand-lavender/50 blur-3xl dark:bg-brand-purple/30" />
        <div className="absolute -bottom-48 -left-40 size-[30rem] rounded-full bg-brand-magenta/10 blur-3xl" />
      </div>
      <main id="main" className="relative flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12 sm:py-16">
        <Logo size={40} className="[&>span:last-child]:text-2xl" />
        <div className={`w-full ${wide ? "max-w-lg" : "max-w-md"} rounded-2xl border border-border bg-surface p-6 shadow-overlay sm:p-8`}>
          <div className="flex flex-col gap-4">{children}</div>
        </div>
      </main>
    </div>
  );
}
