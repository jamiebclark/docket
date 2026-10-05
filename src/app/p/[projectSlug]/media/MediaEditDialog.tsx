"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { MediaView } from "@/server/services/media";
import { updateMediaAction } from "./actions";
import { controlStyles } from "@/components/ui/controls";

export function MediaEditDialog({ slug, item, open, onClose }: { slug: string; item: MediaView; open: boolean; onClose: () => void }) {
  const [alt, setAlt] = useState(item.altText);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function save() {
    setError("");
    start(async () => {
      const list = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const res = await updateMediaAction(slug, { id: item.id, altText: alt, tags: list });
      if (res.ok) onClose();
      else setError(res.fieldErrors?.tags ?? res.fieldErrors?.altText ?? res.message);
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Edit image details">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={`alt-${item.id}`} className="text-sm font-medium">
            Alt text
          </label>
          <textarea
            id={`alt-${item.id}`}
            value={alt}
            maxLength={2000}
            rows={3}
            onChange={(e) => setAlt(e.target.value)}
            className={controlStyles}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`tags-${item.id}`} className="text-sm font-medium">
            Tags
          </label>
          <input
            id={`tags-${item.id}`}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            aria-describedby={`tags-hint-${item.id}`}
            className={controlStyles}
          />
          <p id={`tags-hint-${item.id}`} className="text-xs text-muted-foreground">
            Separate with commas. Up to 20 tags.
          </p>
        </div>
        <p role="alert" className="min-h-4 text-xs text-danger">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" pending={pending} pendingLabel="Saving…">
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
