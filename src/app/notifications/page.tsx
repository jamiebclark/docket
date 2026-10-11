import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotificationPreferenceGrid } from "@/components/notifications/NotificationPreferenceGrid";
import { NotificationList } from "@/components/notifications/NotificationList";
import { SignedInHeader } from "@/components/shell/SignedInHeader";
import { Button, buttonStyles } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSession } from "@/server/auth/session";
import { forMyProjects } from "@/server/dal";
import { myNotificationPreferences, recentPanel } from "@/server/services/notifications";
import {
  markAllConfirmation,
  muteErrorText,
  parseMuteError,
  parseRowErrorCode,
  parseSwitchChange,
  preferenceHelpText,
  projectSwitchConfirmation,
  rowErrorText,
  snoozedConfirmation,
  switchConfirmation,
} from "@/lib/notifications/text";
import { markAllRead, setNotifications } from "./actions";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NotificationsPage({ searchParams }: Props) {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const set = await forMyProjects(session);
  const now = new Date();
  const panel = await recentPanel(set, now);
  const rows = await myNotificationPreferences(set);
  const raw = await searchParams;
  const muteError = parseMuteError(raw.notifications);
  const marked = raw.marked === "1";
  const busy = typeof raw.busy === "string" ? raw.busy.split(",").filter(Boolean) : [];
  const snoozesCleared = typeof raw.snoozes === "string" ? Number.parseInt(raw.snoozes, 10) || 0 : 0;
  const changedSlug = typeof raw.changed === "string" ? raw.changed : undefined;
  const changedRow = changedSlug ? rows.find((r) => r.slug === changedSlug) : undefined;
  const change = changedRow ? parseSwitchChange(raw) : null;
  const switchLookup = change
    ? change.axis === "kind"
      ? changedRow!.kinds.find((k) => k.key === change.key)
      : change.axis === "platform"
        ? changedRow!.platforms.find((k) => k.key === change.key)
        : undefined
    : undefined;
  const read = raw.read === "1";
  const rowError = parseRowErrorCode(raw.rowError);
  const snoozedSlug = typeof raw.snoozed === "string" ? raw.snoozed : undefined;
  let snoozedText: string | null = null;
  if (snoozedSlug !== undefined) {
    const project = set.projects.find((p) => p.slug === snoozedSlug);
    const untilRaw = typeof raw.until === "string" ? raw.until : undefined;
    const until = untilRaw ? new Date(untilRaw) : null;
    snoozedText = project && until && !Number.isNaN(until.getTime()) ? snoozedConfirmation(until, project.timeZone) : "Snoozed.";
  }

  const switchAction = async (formData: FormData) => {
    "use server";
    await setNotifications(null, formData);
  };

  return (
    <>
      <SignedInHeader user={session.user} />
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <PageHeader
          title="Notifications"
          description="Problems from your projects, and which projects can notify you. Problems always stay in Activity."
        />
        {panel.state === "no_projects" ? (
          <EmptyState
            message="You are not a member of any project yet."
            action={
              <Link href="/" className={buttonStyles({ variant: "secondary" })}>
                Back to Docket
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-6">
            {muteError ? <Alert tone="danger">{muteErrorText(muteError)}</Alert> : null}
            {change ? (
              <Alert tone="success">
                {change.axis === "project"
                  ? projectSwitchConfirmation(changedRow!.name, change.on)
                  : switchLookup
                    ? switchConfirmation(changedRow!.name, switchLookup.label, change.on)
                    : "Notifications updated."}
              </Alert>
            ) : null}
            {marked ? (
              <Alert tone="success">
                {busy.length > 0
                  ? `Marked as read. Could not mark ${busy.join(", ")} as read; try again.`
                  : markAllConfirmation(snoozesCleared)}
              </Alert>
            ) : null}
            {read ? <Alert tone="success">Marked as read.</Alert> : null}
            {snoozedText ? <Alert tone="success">{snoozedText}</Alert> : null}
            {rowError ? <Alert tone="danger">{rowErrorText(rowError)}</Alert> : null}
            <Card
              title="Recent problems"
              actions={
                <div className="flex items-center gap-2">
                  {panel.unread.count > 0 ? (
                    <form
                      action={async (formData: FormData) => {
                        "use server";
                        await markAllRead(null, formData);
                      }}
                    >
                      <input type="hidden" name="returnTo" value="/notifications" />
                      <Button type="submit" variant="secondary" size="sm">
                        Mark all as read
                      </Button>
                    </form>
                  ) : null}
                  <Link href="/activity?outcome=problems" prefetch={false} className={buttonStyles({ variant: "secondary", size: "sm" })}>
                    View all problems
                  </Link>
                </div>
              }
            >
              {panel.state === "all_muted" ? (
                <p className="text-sm text-muted-foreground">Notifications are off for all of your projects.</p>
              ) : (
                <NotificationList items={panel.items} now={now} returnTo="/notifications" />
              )}
            </Card>
            <Card title="Projects" padded={false}>
              <NotificationPreferenceGrid rows={rows} action={switchAction} />
            </Card>
            <p className="text-sm text-muted-foreground">{preferenceHelpText()}</p>
            <p className="text-sm text-muted-foreground">
              Docket only notifies you inside Docket. To get problems by email, chat or phone, send its webhooks to a tool such as n8n (see the docs).
            </p>
          </div>
        )}
      </main>
    </>
  );
}
