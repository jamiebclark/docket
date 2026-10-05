"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { MediaView, PostRef } from "@/server/services/media";
import { deleteMediaAction, deleteMediaImpactAction } from "./actions";

type Impact = { blocked: PostRef[]; affected: PostRef[] };

function PostList({ slug, refs }: { slug: string; refs: PostRef[] }) {
  return (
    <ul className="my-2 list-disc pl-5 text-sm">
      {refs.map((r) => (
        <li key={r.postId}>
          <Link href={`/p/${slug}/compose/${r.postId}`} className="underline">
            {r.excerpt || "(no text)"}
          </Link>{" "}
          ({r.status})
        </li>
      ))}
    </ul>
  );
}

/** Mount it fresh for each opening (`key`): it loads the impact first: a blocked image shows the posts holding it; otherwise the confirmation names the posts it will leave. */
export function DeleteMediaDialog({ slug, item, open, onClose }: { slug: string; item: MediaView; open: boolean; onClose: () => void }) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    void deleteMediaImpactAction(slug, { id: item.id }).then((res) => {
      if (!live) return;
      if (res.ok) setImpact(res.data);
      else setError(res.message);
    });
    return () => {
      live = false;
    };
  }, [open, slug, item.id]);

  function confirm() {
    setError("");
    start(async () => {
      const res = await deleteMediaAction(slug, { id: item.id });
      if (res.ok) onClose();
      else setError(res.message);
    });
  }

  const blocked = impact && impact.blocked.length > 0;
  return (
    <Dialog open={open} onClose={onClose} title={blocked ? "This image can't be deleted yet" : "Delete this image?"}>
      {!impact && !error ? <p className="text-sm">Checking where this image is used…</p> : null}
      {blocked ? (
        <>
          <p className="text-sm">It is used by posts that are scheduled, publishing or need attention. Change or cancel them first:</p>
          <PostList slug={slug} refs={impact.blocked} />
        </>
      ) : null}
      {impact && !blocked ? (
        <>
          <p className="text-sm">
            {impact.affected.length === 0
              ? "No posts use this image. It will be removed from the library."
              : "It will be removed from the library and from these posts:"}
          </p>
          <PostList slug={slug} refs={impact.affected} />
        </>
      ) : null}
      <p role="alert" className="min-h-4 text-xs text-danger">
        {error}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {blocked ? "Close" : "Cancel"}
        </Button>
        {impact && !blocked ? (
          <Button variant="danger" pending={pending} pendingLabel="Deleting…" onClick={confirm}>
            Delete image
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
