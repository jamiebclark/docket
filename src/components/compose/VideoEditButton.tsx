"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { isDefaultEdit, type VideoEdit } from "@/lib/video/edit";
import type { MediaView } from "@/server/services/media";
import { VideoEditDialog } from "./VideoEditDialog";

/** "Edit video" under an attached video in the composer's media list; opens the edit dialog. */
export function VideoEditButton({
  media,
  label,
  edit,
  disabled = false,
  cutNotes = [],
  onSave,
}: {
  media: MediaView;
  label: string;
  edit: VideoEdit;
  /** Read-only members and posts that have started publishing cannot edit. */
  disabled?: boolean;
  /** What each checked target will cut from this video, from the last check. */
  cutNotes?: string[];
  onSave: (edit: VideoEdit) => void;
}) {
  const [open, setOpen] = useState(false);
  // The length comes from the probe: a video still processing has nothing to trim yet.
  const ready = media.status === "ready" && media.video !== null;
  return (
    <>
      <Button type="button" variant="secondary" size="sm" disabled={disabled || !ready} onClick={() => setOpen(true)}>
        Edit video{isDefaultEdit(edit) ? "" : " (edited)"}
        <span className="sr-only"> {label}</span>
      </Button>
      <VideoEditDialog open={open} onClose={() => setOpen(false)} media={media} label={label} edit={edit} cutNotes={cutNotes} onSave={onSave} />
    </>
  );
}
