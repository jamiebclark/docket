import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ZodError } from "zod";
import { buttonStyles } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { firstParam } from "@/lib/validation/media";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getCalendar } from "@/server/services/calendar";
import { CalendarBoard } from "./CalendarBoard";
import { ChoiceField } from "@/components/ui/ChoiceField";

export const metadata: Metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const linkClass = buttonStyles({ variant: "secondary" });
const segmentClass = "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export default async function CalendarPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const view = firstParam(raw.view) === "week" ? "week" : "month";
  const dateParam = firstParam(raw.date);
  const account = firstParam(raw.account);
  let calendar;
  try {
    calendar = await getCalendar(scope, {
      view,
      date: dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : undefined,
      accountId: account || undefined,
    });
  } catch (error) {
    // A malformed date or an unknown account falls back to the default view rather than an error page.
    if (error instanceof NotFoundError || error instanceof ZodError || error instanceof RangeError) calendar = await getCalendar(scope, { view });
    else throw error;
  }

  const href = (o: { view?: string; date?: string }) => {
    const qs = new URLSearchParams({ view: o.view ?? calendar.view, date: o.date ?? calendar.today });
    if (account && calendar.accounts.some((a) => a.id === account)) qs.set("account", account);
    return `/p/${projectSlug}/calendar?${qs}`;
  };
  const hasContent = calendar.days.some((d) => d.items.length > 0);
  const canSchedule = scope.can({ post: ["schedule"] });

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">
        {calendar.title} <span className="text-base font-normal text-muted-foreground">· {calendar.timeZone}</span>
      </h1>
      <div className="flex flex-wrap items-end gap-2">
        <nav aria-label="Calendar navigation" className="flex gap-2">
          <Link href={href({ date: calendar.prev })} className={linkClass}>
            Previous
          </Link>
          <Link href={href({ date: calendar.today })} className={linkClass}>
            Today
          </Link>
          <Link href={href({ date: calendar.next })} className={linkClass}>
            Next
          </Link>
        </nav>
        <nav aria-label="Calendar view" className="flex gap-1 rounded-xl border border-border bg-surface p-1 shadow-card">
          {(["month", "week"] as const).map((v) => (
            <Link key={v} href={href({ view: v })} aria-current={calendar.view === v ? "page" : undefined} className={`${segmentClass} ${calendar.view === v ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
              {v === "month" ? "Month" : "Week"}
            </Link>
          ))}
        </nav>
        <form method="get" action={`/p/${projectSlug}/calendar`} className="flex items-end gap-2">
          <input type="hidden" name="view" value={calendar.view} />
          <input type="hidden" name="date" value={calendar.today} />
          <ChoiceField
            id="calendar-account"
            name="account"
            label="Account"
            compact
            autoSubmit
            defaultValue={account ?? ""}
            options={[
              { value: "", label: "All accounts" },
              ...calendar.accounts.map((a) => ({ value: a.id, label: a.displayName, description: a.providerName })),
            ]}
          />
          <noscript>
            <button type="submit" className={linkClass}>
              Filter
            </button>
          </noscript>
        </form>
      </div>
      {!hasContent ? (
        <EmptyState
          message="No posts or posting slots in this period. Posting slots are set per account."
          action={
            <Link href={`/p/${projectSlug}/accounts`} className={linkClass}>
              Go to Accounts
            </Link>
          }
        />
      ) : null}
      <CalendarBoard slug={projectSlug} calendar={calendar} canSchedule={canSchedule} />
    </section>
  );
}
