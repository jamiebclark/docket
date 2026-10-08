"use client";

import { buttonStyles } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

export default function NotificationsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-4">
      <section role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-danger-bg text-danger">
          <Icon name="failures" size={22} />
        </span>
        <h1 className="text-2xl font-semibold">Notifications could not be loaded.</h1>
        <button type="button" onClick={reset} className={buttonStyles({ variant: "secondary" })}>
          Try again
        </button>
      </section>
    </main>
  );
}
