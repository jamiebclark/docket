"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { Button } from "@/components/ui/Button";

type Action = (prev: ActionResult<never> | null, formData: FormData) => Promise<ActionResult<never>>;

/** Accept / Decline for one invitation; `hidden` carries the invitation id or token. */
export function DecisionForm({
  hidden,
  accept,
  decline,
  subject,
}: {
  hidden: { name: string; value: string };
  accept: Action;
  decline: Action;
  /** Names the invitation for assistive technology, e.g. the project name. */
  subject: string;
}) {
  const [acceptState, acceptAction, accepting] = useActionState(accept, null);
  const [declineState, declineAction, declining] = useActionState(decline, null);
  const error = [acceptState, declineState].find((s) => s && !s.ok);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <form action={acceptAction}>
          <input type="hidden" name={hidden.name} value={hidden.value} />
          <Button type="submit" pending={accepting} pendingLabel="Accepting…" disabled={declining} aria-label={`Accept invitation to ${subject}`}>
            Accept
          </Button>
        </form>
        <form action={declineAction}>
          <input type="hidden" name={hidden.name} value={hidden.value} />
          <Button type="submit" variant="secondary" pending={declining} pendingLabel="Declining…" disabled={accepting} aria-label={`Decline invitation to ${subject}`}>
            Decline
          </Button>
        </form>
      </div>
      {error && !error.ok ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
