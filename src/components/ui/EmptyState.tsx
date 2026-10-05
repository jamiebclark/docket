import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/** One sentence on what goes here, plus the primary action to create it. `icon` is decorative. */
export function EmptyState({ message, action, icon = "inbox" }: { message: string; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-input/70 bg-surface px-6 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-accent/60 text-accent-foreground">
        <Icon name={icon} size={22} />
      </span>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}
