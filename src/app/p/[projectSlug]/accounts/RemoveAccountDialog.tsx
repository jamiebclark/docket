"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { accountRemovalImpactAction, removeAccountAction } from "./actions";

/** Loads the impact count when opened, so the confirmation says how many unpublished posts lose this account. */
export function RemoveAccountDialog({ slug, id, name }: { slug: string; id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    void accountRemovalImpactAction(slug, { id }).then((res) => {
      if (!live) return;
      if (res.ok) setCount(res.data.unpublishedPosts);
      else setError(res.message);
    });
    return () => {
      live = false;
    };
  }, [open, slug, id]);

  function confirm() {
    setError("");
    start(async () => {
      const res = await removeAccountAction(slug, { id });
      if (res.ok) setOpen(false);
      else setError(res.message);
    });
  }

  return (
    <>
      <Button
        variant="danger"
        onClick={() => {
          setCount(null);
          setError("");
          setOpen(true);
        }}
      >
        Remove account<span className="sr-only"> {name}</span>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Remove ${name}?`}>
        {count === null && !error ? <p className="text-sm">Checking what this affects…</p> : null}
        {count !== null ? (
          <p className="text-sm">
            {count === 0
              ? "No unpublished posts use this account."
              : `${count} unpublished ${count === 1 ? "post" : "posts"} will no longer be published to ${name}.`}{" "}
            Already published posts are kept.
          </p>
        ) : null}
        <p role="alert" className="min-h-4 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" pending={pending} pendingLabel="Removing…" disabled={count === null} onClick={confirm}>
            Remove account
          </Button>
        </div>
      </Dialog>
    </>
  );
}
