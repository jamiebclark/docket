import type { ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { docsHref } from "@/lib/docs";

/**
 * One permission message about one account — "needs a reconnect", "is not available" — wherever it
 * appears (design-system.md §18).
 *
 * It exists because the same message was hand-rolled five times across the accounts page, the inbox
 * and the inbox item page: a bare `<p>`, a bold lead-in, the reason as loose text, and on the
 * accounts page a Reconnect button floating underneath with nothing grouping it to the sentence
 * that asked for it. `Alert` was already in the design system, with these tones and the right
 * `role` behaviour, and none of them used it.
 *
 * The action belongs inside the box. A control beneath an untinted sentence reads as unrelated to
 * it, which is exactly how it looked.
 */
export function PermissionNotice({
  title,
  reason,
  docsPath,
  docsLabel = "Learn more",
  tone = "warning",
  action,
}: {
  title: string;
  reason: string;
  docsPath?: string;
  docsLabel?: string;
  /** `warning` when the member can do something about it; `info` when they cannot. */
  tone?: "warning" | "info";
  action?: ReactNode;
}) {
  return (
    <Alert tone={tone} title={title}>
      <p>
        {reason}
        {docsPath ? (
          <>
            {" "}
            <a href={docsHref(docsPath)} className="font-medium underline underline-offset-2">
              {docsLabel} →
            </a>
          </>
        ) : null}
      </p>
      {action ? <div className="mt-3 flex flex-wrap items-center gap-2">{action}</div> : null}
    </Alert>
  );
}
