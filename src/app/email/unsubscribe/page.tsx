import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/brand/AuthShell";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonStyles } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { emailConfirmationText, formatHourLabel } from "@/lib/email/text";
import { readUnsubscribe, type UnsubscribeView } from "@/server/services/email";
import { allOff, backOn, digestInstead, projectOff } from "./actions";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function nowStateText(view: UnsubscribeView): string {
  if (view.cadence === "off") return "You are not getting problem emails.";
  if (view.cadence === "digest") return `You are getting one email a day at ${formatHourLabel(view.digestHour)} (${view.timeZone}).`;
  return "You are getting an email about problems as soon as they appear.";
}

function doneText(done: string | undefined, project: string | undefined, view: UnsubscribeView): string | null {
  if (!done) return null;
  const notAffected = "Your notifications inside Docket are not changed by anything on this page.";
  if (done === "all_off") return `Problem emails are off. You will not be emailed about problems in any project. ${notAffected}`;
  if (done === "back_on") return `${emailConfirmationText("immediate")} ${notAffected}`;
  if (done === "digest") return `${emailConfirmationText("digest", { hour: formatHourLabel(view.digestHour), zone: view.timeZone })} ${notAffected}`;
  if (done === "project_off") {
    const found = project ? view.projects.find((p) => p.slug === project) : undefined;
    return found
      ? `${emailConfirmationText("project_off", { projectName: found.name })} ${notAffected}`
      : `Email settings updated. ${notAffected}`;
  }
  return null;
}

export default async function UnsubscribePage({ searchParams }: Props) {
  const raw = await searchParams;
  const token = typeof raw.t === "string" ? raw.t : "";
  const done = typeof raw.done === "string" ? raw.done : undefined;
  const project = typeof raw.project === "string" ? raw.project : undefined;
  const view = await readUnsubscribe(token, new Date());

  if (!view.valid) {
    return (
      <AuthShell>
        <h1 className="text-2xl font-semibold">This link cannot be used</h1>
        <p className="text-sm text-muted-foreground">
          It may have expired, or it may have been changed on its way here. Sign in to change your email settings, or use the link in a
          more recent email.
        </p>
        <Link href="/login" className={buttonStyles({ variant: "primary", className: "self-start" })}>
          Sign in
        </Link>
      </AuthShell>
    );
  }

  const confirmation = doneText(done, project, view);
  const focusProject = view.focusSlug ? view.projects.find((p) => p.slug === view.focusSlug) : undefined;

  return (
    <AuthShell width="lg">
      <PageHeader title="Problem emails" />
      <div className="flex flex-col gap-4">
        {confirmation ? (
          <Alert tone="success">{confirmation}</Alert>
        ) : (
          <p className="text-sm text-foreground">{nowStateText(view)}</p>
        )}

        <form action={allOff}>
          <input type="hidden" name="t" value={token} />
          <Button type="submit" variant="primary" className="w-full sm:w-auto">
            Stop all problem emails
          </Button>
        </form>

        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <legend className="mb-1 text-sm font-medium text-foreground">Or something less drastic</legend>

          {focusProject && !focusProject.excluded ? (
            <form action={projectOff}>
              <input type="hidden" name="t" value={token} />
              <input type="hidden" name="projectSlug" value={focusProject.slug} />
              <Button type="submit" variant="secondary" size="sm">
                Stop only {focusProject.name}
              </Button>
            </form>
          ) : null}

          {view.cadence !== "digest" ? (
            <form action={digestInstead}>
              <input type="hidden" name="t" value={token} />
              <Button type="submit" variant="secondary" size="sm">
                Send one email a day instead
              </Button>
            </form>
          ) : null}

          {view.cadence === "off" ? (
            <form action={backOn}>
              <input type="hidden" name="t" value={token} />
              <Button type="submit" variant="secondary" size="sm">
                Turn problem emails back on
              </Button>
            </form>
          ) : null}
        </fieldset>

        <p className="text-sm text-muted-foreground">
          Your notifications inside Docket are not changed by anything on this page. The bell, the problems list and your per-project
          switches stay exactly as they are.
        </p>

        <p className="text-sm text-muted-foreground">
          Signed in, you can change all of this on your{" "}
          <Link href="/notifications" className="text-primary underline">
            Notifications page
          </Link>
          .
        </p>
      </div>
    </AuthShell>
  );
}
