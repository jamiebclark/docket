"use client";

import { buttonStyles } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

export default function AllActivityError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-4">
      <section role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-danger-bg text-danger">
          <Icon name="failures" size={22} />
        </span>
        <h1 className="text-2xl font-semibold">Activity could not be loaded.</h1>
        {/*
          Next stamps a server error with a `digest` and logs the same value beside the stack. Showing it
          is the only way a person can tell us *which* failure they hit: on 2026-10-17 a production error
          page and a log line reading `digest: '536356245'` could not be connected to each other, and the
          page named no reference at all. The digest is a hash, not data — it carries nothing private.
        */}
        {error.digest ? (
          <p className="text-xs text-muted-foreground">
            Reference <code className="font-mono">{error.digest}</code> — quote this if you report it; the server log
            records the same value.
          </p>
        ) : null}
        <button type="button" onClick={reset} className={buttonStyles({ variant: "secondary" })}>
          Try again
        </button>
      </section>
    </main>
  );
}
