import { ChecklistRows, type ChecklistItem } from "./Checklist";
import { Icon, type IconName } from "./Icon";

/**
 * A "you can't do this yet" panel: EmptyState's dashed frame and icon, a title, an optional lead sentence and the
 * list of prerequisites (ChecklistRows). Use for prerequisite gates; use Checklist for progress lists. `icon` is
 * decorative. Server-compatible.
 */
export function SetupNotice({
  title,
  items,
  lead,
  icon = "info",
  headingLevel = 2,
  id = "setup-notice",
}: {
  title: string;
  items: readonly ChecklistItem[];
  lead?: string;
  icon?: IconName;
  headingLevel?: 2 | 3;
  id?: string;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-input/70 bg-surface px-6 py-10 text-center"
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-accent/60 text-accent-foreground">
        <Icon name={icon} size={22} />
      </span>
      <Heading id={`${id}-title`} className="text-base font-semibold text-heading">
        {title}
      </Heading>
      {lead ? <p className="max-w-md text-sm text-muted-foreground">{lead}</p> : null}
      <div className="mx-auto w-full max-w-xl text-left">
        <ChecklistRows items={items} />
      </div>
    </section>
  );
}
