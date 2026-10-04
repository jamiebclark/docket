"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { startOAuthConnectAction } from "./actions";

/** Starts the group's sign-in from a card that needs reconnecting; the chooser then updates that account in place. */
export function ReconnectGroupButton({ slug, groupKey, displayName }: { slug: string; groupKey: string; displayName: string }) {
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();

  function begin() {
    setMessage("");
    start(async () => {
      // On success the action redirects to the platform's login, so a result only arrives on failure.
      const res = await startOAuthConnectAction(slug, { groupKey });
      if (res && !res.ok) setMessage(res.message);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button type="button" onClick={begin} pending={pending} pendingLabel="Opening…">
          Reconnect with {displayName}
        </Button>
      </div>
      <p role="alert" className="min-h-4 text-sm text-red-700 dark:text-red-400">
        {message}
      </p>
    </div>
  );
}
