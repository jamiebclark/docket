import type { ReactNode } from "react";

/** One sentence on what goes here, plus the primary action to create it. */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-foreground/30 p-6">
      <p className="text-sm">{message}</p>
      {action}
    </div>
  );
}
