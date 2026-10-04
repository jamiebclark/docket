"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { CopyField } from "@/components/ui/CopyField";
import { startOAuthConnectAction } from "./actions";

export interface ConnectGroupSectionProps {
  slug: string;
  groupKey: string;
  displayName: string;
  providerNames: string[];
  configured: boolean;
  setupDoc: string | null;
  redirectUri: string;
  /** Editors see no connect action. */
  canManage: boolean;
}

/** One "Connect <group>" section, rendered once per group even when two providers share it. */
export function ConnectGroupSection(props: ConnectGroupSectionProps) {
  const { slug, groupKey, displayName, providerNames, configured, setupDoc, redirectUri, canManage } = props;
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const headingId = `connect-group-${groupKey}-heading`;

  function begin() {
    setMessage("");
    start(async () => {
      // On success the action redirects to the platform's login, so a result only arrives on failure.
      const res = await startOAuthConnectAction(slug, { groupKey });
      if (res && !res.ok) setMessage(res.message);
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border border-foreground/20 p-4">
      <h2 id={headingId} className="text-lg font-semibold">
        Connect {displayName}
      </h2>
      <p className="text-sm text-foreground/80">Connects {providerNames.join(" and ")} accounts with one sign-in.</p>
      {!configured ? (
        <div className="flex max-w-xl flex-col gap-2 text-sm">
          <p>
            {displayName} is not configured on this server.
            {setupDoc ? <> Follow the setup guide in <code>{setupDoc}</code>.</> : null}
          </p>
          <CopyField id={`connect-group-${groupKey}-redirect`} label="Redirect address to register" value={redirectUri} />
        </div>
      ) : canManage ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button type="button" onClick={begin} pending={pending} pendingLabel="Opening…">
              Connect {displayName}
            </Button>
          </div>
          <p role="alert" className="min-h-4 text-sm text-red-700 dark:text-red-400">
            {message}
          </p>
        </div>
      ) : null}
    </section>
  );
}
