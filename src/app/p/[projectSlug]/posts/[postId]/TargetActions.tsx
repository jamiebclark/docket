"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { ActionResult } from "@/lib/action-result";
import { cancelTargetAction, deletePostAction, resolveTargetAction, retryTargetAction } from "../actions";

type Kind = "cancel" | "resolve-published" | "resolve-failed" | "delete" | null;

/** Retry, cancel and resolve for one target, or (with `postId` only) delete for the whole post. */
export function TargetActions({
  slug,
  targetId,
  postId,
  accountName,
  status,
  canSchedule,
  canDelete,
  deleteBlocked,
}: {
  slug: string;
  targetId?: string;
  postId?: string;
  accountName?: string;
  status?: string;
  canSchedule?: boolean;
  canDelete?: boolean;
  deleteBlocked?: boolean;
}) {
  const [open, setOpen] = useState<Kind>(null);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [pending, start] = useTransition();

  function run(fn: () => Promise<ActionResult<unknown>>, after?: () => void) {
    setError("");
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setOpen(null);
        after?.();
      } else setError(res.message);
    });
  }
  const close = () => {
    setOpen(null);
    setError("");
  };
  const errorLine = (
    <p role="alert" className="min-h-4 text-xs text-red-700 dark:text-red-400">
      {error}
    </p>
  );

  if (postId && !targetId) {
    if (!canDelete) return null;
    return (
      <>
        <Button variant="danger" onClick={() => setOpen("delete")}>
          Delete post
        </Button>
        <Dialog open={open === "delete"} onClose={close} title={deleteBlocked ? "This post can't be deleted" : "Delete this post?"}>
          <p className="text-sm">
            {deleteBlocked
              ? "At least one account has published, is publishing or needs your decision. Cancel what is still waiting instead."
              : "Anything still scheduled will be cancelled and the post will be removed from your lists."}
          </p>
          {errorLine}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {deleteBlocked ? "Close" : "Keep post"}
            </Button>
            {deleteBlocked ? null : (
              <Button variant="danger" pending={pending} pendingLabel="Deleting…" onClick={() => run(() => deletePostAction(slug, { postId }))}>
                Delete post
              </Button>
            )}
          </div>
        </Dialog>
      </>
    );
  }

  if (!targetId || !canSchedule) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "failed" ? (
        <Button pending={pending} pendingLabel="Retrying…" onClick={() => run(() => retryTargetAction(slug, { targetId }))}>
          Retry
        </Button>
      ) : null}
      {status === "scheduled" || status === "draft" ? (
        <Button variant="secondary" onClick={() => setOpen("cancel")}>
          Cancel
        </Button>
      ) : null}
      {status === "ambiguous" ? (
        <>
          <Button onClick={() => setOpen("resolve-published")}>Mark as published</Button>
          <Button variant="secondary" onClick={() => setOpen("resolve-failed")}>
            Mark as not published
          </Button>
        </>
      ) : null}
      {error && !open ? errorLine : null}

      <Dialog open={open === "cancel"} onClose={close} title={`Cancel the post to ${accountName}?`}>
        <p className="text-sm">It won&apos;t be published to this account. Other accounts are not affected.</p>
        {errorLine}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Keep scheduled
          </Button>
          <Button variant="danger" pending={pending} pendingLabel="Cancelling…" onClick={() => run(() => cancelTargetAction(slug, { targetId }))}>
            Cancel post
          </Button>
        </div>
      </Dialog>

      <Dialog open={open === "resolve-published"} onClose={close} title={`Mark as published to ${accountName}?`}>
        <p className="text-sm">Confirm you saw this post on the account. It will be recorded as published.</p>
        <label className="mt-3 block text-sm">
          Link to the post (optional)
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            className="mt-1 w-full rounded-md border border-foreground/30 bg-background px-2 py-1.5"
          />
        </label>
        {errorLine}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Back
          </Button>
          <Button pending={pending} pendingLabel="Saving…" onClick={() => run(() => resolveTargetAction(slug, { targetId, outcome: "published", url }))}>
            Mark as published
          </Button>
        </div>
      </Dialog>

      <Dialog open={open === "resolve-failed"} onClose={close} title={`Mark as not published to ${accountName}?`}>
        <p className="text-sm">Confirm the post is not on the account. It will be recorded as failed, and you can retry it.</p>
        {errorLine}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Back
          </Button>
          <Button pending={pending} pendingLabel="Saving…" onClick={() => run(() => resolveTargetAction(slug, { targetId, outcome: "failed" }))}>
            Mark as not published
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
