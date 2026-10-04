"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { CopyField } from "@/components/ui/CopyField";
import { Field } from "@/components/ui/Field";
import { pasteConnectTokenAction, startOAuthConnectAction } from "./actions";

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
  /** Present when the group accepts a token generated in the platform's own tools. */
  paste?: { label: string; help: string } | null;
}

/** One "Connect <group>" section, rendered once per group even when two providers share it. */
export function ConnectGroupSection(props: ConnectGroupSectionProps) {
  const { slug, groupKey, displayName, providerNames, configured, setupDoc, redirectUri, canManage, paste } = props;
  const [token, setToken] = useState("");
  const [pasteMessage, setPasteMessage] = useState("");
  const [pastePending, startPaste] = useTransition();
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

  function submitPaste(e: React.FormEvent) {
    e.preventDefault();
    setPasteMessage("");
    const value = token;
    // The field is emptied as soon as it is submitted; the token is never kept in the page.
    setToken("");
    startPaste(async () => {
      const res = await pasteConnectTokenAction(slug, { groupKey, token: value });
      if (res && !res.ok) setPasteMessage(res.message);
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
          {paste ? (
            <form onSubmit={submitPaste} className="flex max-w-md flex-col gap-2" aria-label={`Paste a ${displayName} token`}>
              <Field
                id={`connect-group-${groupKey}-token`}
                label={paste.label}
                hint={`${paste.help} Needed permissions: pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic, instagram_content_publish.`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                required
                aria-required
              />
              <p role="alert" className="min-h-4 text-sm text-red-700 dark:text-red-400">
                {pasteMessage}
              </p>
              <div>
                <Button type="submit" pending={pastePending} pendingLabel="Checking…">
                  Use this token
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
