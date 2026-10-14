import Link from "next/link";
import type { ReactNode } from "react";
import { linkStyles } from "@/components/ui/controls";
import { Logo } from "./Logo";

const WIDTHS = { md: "max-w-md", lg: "max-w-lg", prose: "max-w-2xl" } as const;

const FOOTER_LINKS = [
  { key: "home", href: "/", label: "About" },
  { key: "privacy", href: "/privacy", label: "Privacy Policy" },
] as const;

/**
 * Frame for signed-out and first-run pages (log in, set up, invitation sign-up, the public home page and the
 * privacy policy): a soft lavender brand backdrop with one centred card, and a footer linking to the public
 * pages. Renders the page's `<main id="main">` landmark.
 *
 * - `width`: `md` for forms (default), `lg` for a short list, `prose` for reading text such as the policy.
 * - `current`: the public page being shown, so its footer link carries `aria-current="page"`.
 */
export function AuthShell({
  children,
  width = "md",
  current,
}: {
  children: ReactNode;
  width?: keyof typeof WIDTHS;
  current?: (typeof FOOTER_LINKS)[number]["key"];
}) {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -right-32 size-[34rem] rounded-full bg-brand-lavender/50 blur-3xl dark:bg-brand-purple/30" />
        <div className="absolute -bottom-48 -left-40 size-[30rem] rounded-full bg-brand-magenta/10 blur-3xl" />
      </div>
      <main id="main" className="relative flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12 sm:py-16">
        <Logo size={40} className="[&>span:last-child]:text-2xl" />
        <div className={`w-full ${WIDTHS[width]} rounded-2xl border border-border bg-surface p-6 shadow-overlay sm:p-8`}>
          <div className="flex flex-col gap-4">{children}</div>
        </div>
      </main>
      <footer className="relative px-4 pb-8">
        <nav aria-label="About this site">
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
            {FOOTER_LINKS.map((l) => (
              <li key={l.key}>
                <Link href={l.href} className={linkStyles} aria-current={current === l.key ? "page" : undefined}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </footer>
    </div>
  );
}
