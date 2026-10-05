"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { deletePostAction } from "../actions";

/** Delete for the whole post; per-target actions live in `TargetResolution`. */
export function DeletePostButton({
  slug,
  postId,
  canDelete,
  deleteBlocked,
}: {
  slug: string;
  postId: string;
  canDelete: boolean;
  deleteBlocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  if (!canDelete) return null;
  const close = () => {
    setOpen(false);
    setError("");
  };
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete post
      </Button>
      <Dialog open={open} onClose={close} title={deleteBlocked ? "This post can't be deleted" : "Delete this post?"}>
        <p className="text-sm">
          {deleteBlocked
            ? "At least one account has published, is publishing or needs your decision. Cancel what is still waiting instead."
            : "Anything still scheduled will be cancelled and the post will be removed from your lists."}
        </p>
        <p role="alert" className="min-h-4 text-xs text-danger">
          {error}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {deleteBlocked ? "Close" : "Keep post"}
          </Button>
          {deleteBlocked ? null : (
            <Button
              variant="danger"
              pending={pending}
              pendingLabel="Deleting…"
              onClick={() =>
                start(async () => {
                  setError("");
                  const res = await deletePostAction(slug, { postId });
                  if (res && !res.ok) setError(res.message);
                })
              }
            >
              Delete post
            </Button>
          )}
        </div>
      </Dialog>
    </>
  );
}
