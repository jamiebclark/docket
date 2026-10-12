import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LocalTime } from "@/components/ui/LocalTime";
import { Select } from "@/components/ui/Select";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  allSwitchesOffText,
  digestBeatsQuietText,
  followsSwitchesText,
  formatHourLabel,
  immediateMeansText,
  noProjectsText,
  offKeepsBellText,
  onlyProblemsText,
  pausedFailingText,
  pausedRejectedText,
  unavailableText,
  zoneDerivedText,
  zoneDerivedUtcText,
  zoneUnknownText,
} from "@/lib/email/text";
import type { MyEmailSettings } from "@/server/services/email";
import { BrowserTimeZone } from "./BrowserTimeZone";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: formatHourLabel(hour) }));

function zoneGroups(current: string): { area: string; zones: string[] }[] {
  const all = new Set<string>(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
  all.add("UTC");
  all.add(current);
  const byArea = new Map<string, string[]>();
  for (const zone of all) {
    const area = zone.includes("/") ? zone.split("/")[0]! : "Other";
    const list = byArea.get(area);
    if (list) list.push(zone);
    else byArea.set(area, [zone]);
  }
  return [...byArea.entries()]
    .map(([area, zones]) => ({ area, zones: zones.sort() }))
    .sort((a, b) => a.area.localeCompare(b.area));
}

/**
 * `/notifications`'s "Email" card: cadence, digest hour, time zone, quiet hours, pause/resume, and the
 * sentences FR-038 requires in words. Six states, all fully usable with client JavaScript unavailable
 * (contracts/ui.md §1).
 */
export function EmailSettingsCard({
  settings,
  saveAction,
  resumeAction,
  includeProjectAction,
}: {
  settings: MyEmailSettings;
  saveAction: (formData: FormData) => Promise<void>;
  resumeAction: (formData: FormData) => Promise<void>;
  includeProjectAction: (formData: FormData) => Promise<void>;
}) {
  if (!settings.available) {
    return (
      <Card title="Email">
        <p className="text-sm text-muted-foreground">{unavailableText()}</p>
      </Card>
    );
  }

  const zoneHint =
    settings.zoneSource === "unknown"
      ? zoneUnknownText()
      : settings.zoneSource === "utc"
        ? zoneDerivedUtcText()
        : settings.zoneSource === "projects"
          ? zoneDerivedText(settings.timeZone)
          : null;

  return (
    <Card title="Email" description="Problem notifications by email, in addition to the bell.">
      <div className="flex flex-col gap-4">
        {!settings.transportAvailable ? (
          <Alert tone="warning">
            Email is configured but this build has no mail client installed, so nothing is being sent. Nothing
            is lost: the problems still waiting will be emailed once it is.
          </Alert>
        ) : null}

        {settings.paused ? (
          <Alert tone="danger" title={<span className="inline-flex items-center gap-2">Email paused <Badge tone="danger">Paused</Badge></span>}>
            <p>{settings.paused.reason === "rejected" ? pausedRejectedText() : pausedFailingText()}</p>
            <form action={resumeAction} className="mt-2">
              <Button type="submit" variant="secondary" size="sm">
                <span className="sr-only">Email: </span>Resume email
              </Button>
            </form>
          </Alert>
        ) : null}

        <form action={saveAction} className="flex flex-col gap-4">
          <SegmentedControl
            name="cadence"
            label="How often"
            layout="cards"
            defaultValue={settings.cadence}
            options={[
              { value: "off", label: "Off", description: "No problem emails." },
              { value: "immediate", label: "Immediate", description: "As soon as a problem happens." },
              { value: "digest", label: "Daily digest", description: "One email a day, at an hour you choose." },
            ]}
          />

          <Select id="digestHour" name="digestHour" label="Digest hour" defaultValue={String(settings.digestHour)}>
            {HOUR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>

          <div className="flex flex-col gap-1.5">
            <Select id="timeZone" name="timeZone" label="Time zone" defaultValue={settings.timeZone} hint={zoneHint}>
              {zoneGroups(settings.timeZone).map((g) => (
                <optgroup key={g.area} label={g.area}>
                  {g.zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            {settings.zoneSource !== "chosen" ? <BrowserTimeZone /> : null}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-foreground">Quiet hours</legend>
            {settings.cadence === "digest" ? <p className="text-sm text-muted-foreground">{digestBeatsQuietText()}</p> : null}
            <p className="text-xs text-muted-foreground">Same hour for both means no quiet hours.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                id="quietStartHour"
                name="quietStartHour"
                label="From"
                defaultValue={String(settings.quiet?.startHour ?? 0)}
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select id="quietEndHour" name="quietEndHour" label="To" defaultValue={String(settings.quiet?.endHour ?? 0)}>
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          </fieldset>

          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            <p>{onlyProblemsText()}</p>
            <p>{followsSwitchesText()}</p>
            <p>{offKeepsBellText()}</p>
            {settings.cadence === "immediate" ? <p>{immediateMeansText(settings.immediateIntervalSeconds)}</p> : null}
            {settings.projects.length === 0 ? <p>{noProjectsText()}</p> : null}
            {settings.projects.length > 0 && !settings.anySwitchOn ? <p>{allSwitchesOffText()}</p> : null}
            <p>
              {settings.lastSentAt ? (
                <>
                  Last emailed <LocalTime value={settings.lastSentAt} timeZone={settings.timeZone} />.
                </>
              ) : (
                "You have not been emailed yet."
              )}
            </p>
            {settings.last && settings.last.outcome !== "sent" ? (
              <p>
                Last attempt <LocalTime value={settings.last.at} timeZone={settings.timeZone} /> — {settings.last.outcome.replaceAll("_", " ")}.
              </p>
            ) : null}
          </div>

          <div className="flex justify-end">
            <Button type="submit" variant="primary">
              Save
            </Button>
          </div>
        </form>

        {settings.projects.some((p) => p.excluded) ? (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">Excluded projects</p>
            {settings.projects
              .filter((p) => p.excluded)
              .map((p) => (
                <form key={p.slug} action={includeProjectAction} className="flex items-center justify-between gap-3">
                  <input type="hidden" name="projectSlug" value={p.slug} />
                  <span className="text-sm text-muted-foreground">{p.name}</span>
                  <Button type="submit" variant="secondary" size="sm">
                    Email me about {p.name} again
                  </Button>
                </form>
              ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
