import { Button } from "@/components/ui/Button";
import type { SwitchAxis } from "@/lib/notifications/eligibility";

/**
 * One switch = one `<form>` = one submit button (Q18). No `aria-pressed`: the visible label already
 * is the state. `projectSlug` is omitted on the project settings card, where the route already knows
 * it; `action` is the page's bound server action for that screen.
 */
export function NotificationSwitch({
  action,
  projectSlug,
  projectName,
  axis,
  switchKey,
  label,
  on,
}: {
  action: (formData: FormData) => Promise<void>;
  projectSlug?: string;
  projectName: string;
  axis: SwitchAxis | "project";
  switchKey?: string;
  label: string;
  on: boolean;
}) {
  const verb = on ? "turn off" : "turn on";
  const visible = axis === "project" ? (on ? "Turn all off" : "Turn all on") : on ? "On" : "Off";
  return (
    <form action={action}>
      {projectSlug ? <input type="hidden" name="projectSlug" value={projectSlug} /> : null}
      <input type="hidden" name="axis" value={axis} />
      {switchKey !== undefined ? <input type="hidden" name="key" value={switchKey} /> : null}
      <input type="hidden" name="on" value={on ? "false" : "true"} />
      <Button type="submit" variant="secondary" size="sm">
        {visible}
        {axis === "project" ? (
          <span className="sr-only"> notifications for {projectName}</span>
        ) : (
          <span className="sr-only">
            {" "}
            — {verb} {label} notifications for {projectName}
          </span>
        )}
      </Button>
    </form>
  );
}
