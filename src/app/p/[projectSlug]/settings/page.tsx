import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { muteErrorText, mutedConfirmation, parseMuteError } from "@/lib/notifications/text";
import { myStateForProject } from "@/server/services/notifications";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { setMyProjectNotifications } from "./actions";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Project settings" };
export const dynamic = "force-dynamic";

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const p = scope.project;
  const { on } = await myStateForProject(scope);
  const confirmed = raw.notifications === "on" || raw.notifications === "off" ? raw.notifications === "on" : null;
  const muteError = parseMuteError(raw.notifications);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Project settings</h1>
      <SettingsForm
        canEdit={scope.can({ project: ["update"] })}
        values={{
          name: p.name,
          slug: p.slug,
          timezone: p.timezone,
          defaultApprovalPolicy: p.defaultApprovalPolicy,
          defaultSchedulingPolicy: p.defaultSchedulingPolicy,
        }}
      />
      <Card title="Your notifications" description="Only you see this. Problems in this project always stay in Activity.">
        <div className="flex flex-col gap-4">
          {muteError ? <Alert tone="danger">{muteErrorText(muteError)}</Alert> : null}
          {confirmed !== null ? <Alert tone="success">{mutedConfirmation(p.name, confirmed)}</Alert> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm">
              Notifications for this project are <Badge tone={on ? "success" : "neutral"}>{on ? "on" : "off"}</Badge>.
            </p>
            <form
              action={async (formData: FormData) => {
                "use server";
                await setMyProjectNotifications(null, formData);
              }}
            >
              <input type="hidden" name="projectSlug" value={p.slug} />
              <input type="hidden" name="on" value={on ? "false" : "true"} />
              <Button type="submit" variant="secondary" size="sm">
                {on ? "Turn off" : "Turn on"}
                <span className="sr-only"> notifications for {p.name}</span>
              </Button>
            </form>
          </div>
        </div>
      </Card>
    </div>
  );
}
