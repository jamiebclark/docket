import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";
import { NotificationSwitch } from "@/components/notifications/NotificationSwitch";
import { muteErrorText, parseMuteError, parseSwitchChange, preferenceHelpText, projectOffText, switchConfirmation, projectSwitchConfirmation } from "@/lib/notifications/text";
import { myPreferencesForProject } from "@/server/services/notifications";
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
  const preferences = await myPreferencesForProject(scope);
  const muteError = parseMuteError(raw.notifications);
  const change = raw.changed === "1" ? parseSwitchChange(raw) : null;
  const switchLookup = change
    ? change.axis === "kind"
      ? preferences.kinds.find((k) => k.key === change.key)
      : change.axis === "platform"
        ? preferences.platforms.find((k) => k.key === change.key)
        : undefined
    : undefined;

  const action = async (formData: FormData) => {
    "use server";
    await setMyProjectNotifications(null, formData);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Project settings" description="The project's name, time zone, and how new posts are approved and scheduled." />
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
          {change ? (
            <Alert tone="success">
              {change.axis === "project"
                ? projectSwitchConfirmation(p.name, change.on)
                : switchLookup
                  ? switchConfirmation(p.name, switchLookup.label, change.on)
                  : "Notifications updated."}
            </Alert>
          ) : null}
          <p className="text-sm">{preferences.on ? "Notifications for this project are on." : projectOffText()}</p>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Tell me about</legend>
            <div className="flex flex-wrap gap-2">
              {preferences.kinds.map((k) => (
                <NotificationSwitch
                  key={k.key}
                  action={action}
                  projectSlug={p.slug}
                  projectName={p.name}
                  axis="kind"
                  switchKey={k.key}
                  label={k.label}
                  on={k.on}
                />
              ))}
            </div>
          </fieldset>
          <div className="flex items-center gap-2">
            <NotificationSwitch action={action} projectSlug={p.slug} projectName={p.name} axis="project" label="" on={true} />
            <NotificationSwitch action={action} projectSlug={p.slug} projectName={p.name} axis="project" label="" on={false} />
          </div>
          <details>
            <summary>
              Platforms ({preferences.platforms.filter((pl) => pl.on).length} of {preferences.platforms.length} on) — {p.name}
            </summary>
            {preferences.platforms.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">This project has no connected accounts yet.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {preferences.platforms.map((pl) => (
                  <NotificationSwitch
                    key={pl.key}
                    action={action}
                    projectSlug={p.slug}
                    projectName={p.name}
                    axis="platform"
                    switchKey={pl.key}
                    label={pl.label}
                    on={pl.on}
                  />
                ))}
              </div>
            )}
          </details>
          <p className="text-sm text-muted-foreground">{preferenceHelpText()}</p>
        </div>
      </Card>
    </div>
  );
}
