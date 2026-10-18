"use client";

import { buttonStyles } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

/** FR-024, FR-074: the Insights page fails on its own; the rest of the project shell stays usable. */
export default function InsightsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-bg text-danger">
        <Icon name="failures" size={22} />
      </span>
      <h1 className="text-2xl font-semibold">Insights couldn&apos;t load</h1>
      <p className="text-sm text-muted-foreground">Try again. The rest of this project is unaffected.</p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          Reference <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
      <button type="button" onClick={reset} className={buttonStyles({ variant: "secondary" })}>
        Try again
      </button>
    </section>
  );
}
