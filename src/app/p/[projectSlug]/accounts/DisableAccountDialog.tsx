"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { accountDisableImpactAction, setAccountDisabledAction } from "./actions";

/**
 * Switches one account off or back on.
 *
 * Disabling asks first, because it affects a queue someone built: the dialog loads how many scheduled
 * posts will be held. Enabling asks nothing — it only ever gives capability back — and says how many
 * overdue posts it just made due again, which is the one surprise worth naming out loud.
 */
export function DisableAccountDialog({ slug, id, name, disabled }: { slug: string; id: string; name: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [released, setReleased] = useState<number | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    void accountDisableImpactAction(slug, { id }).then((res) => {
      if (!live) return;
      if (res.ok) setQueued(res.data.queuedPosts);
      else setError(res.message);
    });
    return () => {
      live = false;
    };
  }, [open, slug, id]);

  function set(next: boolean) {
    setError("");
    setReleased(null);
    start(async () => {
      const res = await setAccountDisabledAction(slug, { id, disabled: next });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setOpen(false);
      if (!next) setReleased(res.data.releasedTargets);
    });
  }

  if (!disabled) {
    return (
      <>
        <Button
          variant="secondary"
          onClick={() => {
            setQueued(null);
            setError("");
            setOpen(true);
          }}
        >
          Disable<span className="sr-only"> {name}</span>
        </Button>
        <Dialog open={open} onClose={() => setOpen(false)} title={`Disable ${name}?`}>
          <p className="text-sm">
            {name} stops posting, and Docket stops refreshing its login, reading its numbers and checking its replies. It
            keeps its credentials, its posting slots and its history, and you can enable it again at any time.
          </p>
          {queued === null && !error ? <p className="text-sm">Checking what this affects…</p> : null}
          {queued !== null ? (
            <p className="text-sm">
              {queued === 0
                ? "No scheduled posts are waiting on this account."
                : `${queued} scheduled ${queued === 1 ? "post is" : "posts are"} waiting on this account. ${
                    queued === 1 ? "It stays" : "They stay"
                  } scheduled and ${queued === 1 ? "goes" : "go"} out when you enable it again — nothing fails and nothing is cancelled.`}
            </p>
          ) : null}
          <p role="alert" className="min-h-4 text-xs text-danger">
            {error}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button pending={pending} pendingLabel="Disabling…" disabled={queued === null} onClick={() => set(true)}>
              Disable
            </Button>
          </div>
        </Dialog>
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button pending={pending} pendingLabel="Enabling…" onClick={() => set(false)}>
        Enable<span className="sr-only"> {name}</span>
      </Button>
      {released !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {released === 0
            ? "Enabled. Nothing was waiting."
            : `Enabled. ${released} overdue ${released === 1 ? "post goes" : "posts go"} out on the next tick.`}
        </p>
      ) : null}
      <p role="alert" className="min-h-4 text-xs text-danger">
        {error}
      </p>
    </div>
  );
}
