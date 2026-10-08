import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotificationToggle } from "@/components/notifications/NotificationToggle";
import { NotificationList } from "@/components/notifications/NotificationList";
import { SignedInHeader } from "@/components/shell/SignedInHeader";
import { Button, buttonStyles } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSession } from "@/server/auth/session";
import { forMyProjects } from "@/server/dal";
import { myProjectStates, recentPanel } from "@/server/services/notifications";
import { mutedConfirmation } from "@/lib/notifications/text";
import { markAllRead } from "./actions";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NotificationsPage({ searchParams }: Props) {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const set = await forMyProjects(session);
  const now = new Date();
  const panel = await recentPanel(set, now);
  const states = await myProjectStates(set);
  const raw = await searchParams;
  const marked = raw.marked === "1";
  const busy = typeof raw.busy === "string" ? raw.busy.split(",").filter(Boolean) : [];
  const changed = typeof raw.changed === "string" ? states.find((s) => s.slug === raw.changed) : undefined;

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
            {changed ? <Alert tone="success">{mutedConfirmation(changed.name, changed.on)}</Alert> : null}
            {marked ? (
              <Alert tone="success">
                {busy.length > 0 ? `Marked as read. Could not mark ${busy.join(", ")} as read; try again.` : "Marked as read."}
              </Alert>
            ) : null}
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
                <NotificationList items={panel.items} now={now} />
              )}
            </Card>
            <Card title="Projects" padded={false}>
              <table className="w-full text-sm">
                <caption className="sr-only">Notifications for each of your projects</caption>
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th scope="col" className="px-5 py-2 font-medium">Project</th>
                    <th scope="col" className="px-5 py-2 font-medium">Notifications</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {states.map((s) => (
                    <tr key={s.slug} className="border-b border-border last:border-0">
                      <th scope="row" className="px-5 py-3 text-left font-medium">{s.name}</th>
                      <td className="px-5 py-3">
                        <Badge tone={s.on ? "success" : "neutral"}>{s.on ? "On" : "Off"}</Badge>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end">
                          <NotificationToggle slug={s.slug} name={s.name} on={s.on} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <p className="text-sm text-muted-foreground">
              Docket only notifies you inside Docket. To get problems by email, chat or phone, send its webhooks to a tool such as n8n (see the docs).
            </p>
          </div>
        )}
      </main>
    </>
  );
}
